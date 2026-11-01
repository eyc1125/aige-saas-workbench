/**
 * Windows zip 路径分隔符修正
 * ==================================================================
 * 【要解决的问题（真实踩过，不是理论）】
 *   Windows 上用 PowerShell `Compress-Archive` / .NET `ZipArchive` 打的 zip，
 *   条目名用的是**反斜杠**：`assets\big.bin`、`dist\index.html`。
 *   Linux 上 `unzip` 会打印
 *     `warning: xxx.zip appears to use backslashes as path separators`
 *   并且**退出码是 1**。
 *
 *   它的行为很坑：文件其实**已经正确解压**（目录、大小都对），但退出码非 0。于是：
 *     · 部署脚本里写了 `set -e` → 立刻中断，明明解压好了却报失败；
 *     · AI 看到 exitCode=1 → 判定「部署失败」→ 重试 / 换方案 / 直接说做不到。
 *   这就是「投更不了、上传不了、搞定不了」很典型的一种来源。
 *
 * 【怎么修】
 *   在**上传落盘时**就把条目名里的 `\` 换成 `/`。
 *   关键点：反斜杠 `0x5C` 与正斜杠 `0x2F` 都是**单字节**，且 `0x5C` 不可能出现在
 *   UTF-8 多字节字符的续字节里 —— 所以这是一次**等长字节替换**：
 *   压缩数据、CRC、各段偏移、中央目录大小全部不用动，**不重建压缩包、不重算 CRC**，
 *   风险最低。
 *
 * 【安全兜底】
 *   任何一步解析不符合预期（zip64 / 结构异常 / 偏移越界 / 本地头与中央目录对不上）
 *   就**原样不动**返回 changed=false，绝不抱着「试试看」的心态去改用户的部署包。
 */
'use strict';

const fsp = require('node:fs/promises');

const SIG_LOCAL = 0x04034b50; // PK\x03\x04
const SIG_CENTRAL = 0x02014b50; // PK\x01\x02
const SIG_EOCD = 0x06054b50; // PK\x05\x06

/** EOCD 最小 22 字节，注释最多 65535，所以从末尾回扫 64KB 足够 */
const EOCD_SCAN = 66 * 1024;

/**
 * 在尾部缓冲里找 EOCD（可能有注释，所以回扫）。
 * 返回的 cdOffset / cdSize 都是**相对整个文件**的绝对值。
 */
function findEocd(tail) {
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
    const entries = tail.readUInt16LE(i + 10);
    const cdSize = tail.readUInt32LE(i + 12);
    const cdOffset = tail.readUInt32LE(i + 16);
    // zip64：这三个字段会被写成 0xFFFF / 0xFFFFFFFF —— 不支持，也不该硬改
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return null;
    return { entries, cdSize, cdOffset };
  }
  return null;
}

/** 解析中央目录（buf 就是中央目录本身，坐标从 0 开始） */
function readCentralDirectory(cd, entries) {
  const list = [];
  let p = 0;
  for (let i = 0; i < entries; i += 1) {
    if (p + 46 > cd.length) return null;
    if (cd.readUInt32LE(p) !== SIG_CENTRAL) return null;

    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);

    if (p + 46 + nameLen > cd.length) return null;
    list.push({
      cdNameStart: p + 46,
      nameLen,
      localOffset,
      name: cd.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
    });

    p += 46 + nameLen + extraLen + commentLen;
  }
  return list.length === entries ? list : null;
}

/**
 * 修正一个 zip 的路径分隔符（原地、等长替换）。
 * @param {string} filePath
 * @returns {Promise<{changed:boolean, entries?:number, fixed?:number, reason?:string}>}
 */
async function normalizeZipSeparators(filePath) {
  let handle;
  try {
    handle = await fsp.open(filePath, 'r+');
    const { size } = await handle.stat();
    if (size < 22) return { changed: false, reason: 'not-a-zip' };

    // 只看头 4 字节确认是 zip（PK\x03\x04）
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, 4, 0);
    if (magic.readUInt32LE(0) !== SIG_LOCAL) return { changed: false, reason: 'not-a-zip' };

    // 尾部：EOCD
    const tailLen = Math.min(size, EOCD_SCAN);
    const tail = Buffer.alloc(tailLen);
    await handle.read(tail, 0, tailLen, size - tailLen);
    const eocd = findEocd(tail);
    if (!eocd) return { changed: false, reason: 'eocd-not-found' };
    if (eocd.cdOffset + eocd.cdSize > size) return { changed: false, reason: 'bad-eocd' };

    // 中央目录（只有目录，不含压缩数据，通常几十 KB）
    const cd = Buffer.alloc(eocd.cdSize);
    await handle.read(cd, 0, eocd.cdSize, eocd.cdOffset);
    const entries = readCentralDirectory(cd, eocd.entries);
    if (!entries) return { changed: false, reason: 'bad-central-directory' };

    const broken = entries.filter((e) => e.name.includes('\\'));
    if (!broken.length) return { changed: false, entries: entries.length };

    // 先把要改的地方全部算好并校验一遍，确认无误再动写操作（避免改一半）
    const patches = [];
    for (const entry of broken) {
      if (entry.localOffset + 30 > size) return { changed: false, reason: 'bad-local-offset' };

      const localHeader = Buffer.alloc(30);
      await handle.read(localHeader, 0, 30, entry.localOffset);
      if (localHeader.readUInt32LE(0) !== SIG_LOCAL) {
        return { changed: false, reason: 'bad-local-signature' };
      }
      if (localHeader.readUInt16LE(26) !== entry.nameLen) {
        // 本地头与中央目录的文件名长度对不上 → 结构可疑，整体放弃
        return { changed: false, reason: 'local-name-length-mismatch' };
      }

      const localName = Buffer.alloc(entry.nameLen);
      await handle.read(localName, 0, entry.nameLen, entry.localOffset + 30);

      const cdName = cd.subarray(entry.cdNameStart, entry.cdNameStart + entry.nameLen);
      if (!cdName.equals(localName)) {
        // 两处名字不一致 → 不是我们认识的普通 zip，别动
        return { changed: false, reason: 'name-mismatch' };
      }
      patches.push({
        cdStart: entry.cdNameStart,
        localStart: entry.localOffset + 30,
        nameLen: entry.nameLen,
      });
    }

    // 等长替换：\ (0x5C) → / (0x2F)
    for (const p of patches) {
      const cdName = Buffer.alloc(p.nameLen);
      await handle.read(cdName, 0, p.nameLen, eocd.cdOffset + p.cdStart);
      for (let i = 0; i < cdName.length; i += 1) {
        if (cdName[i] === 0x5c) cdName[i] = 0x2f;
      }
      await handle.write(cdName, 0, cdName.length, eocd.cdOffset + p.cdStart);
      await handle.write(cdName, 0, cdName.length, p.localStart);
    }

    return { changed: true, entries: entries.length, fixed: broken.length };
  } catch (err) {
    return { changed: false, reason: err.message };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

module.exports = { normalizeZipSeparators };
