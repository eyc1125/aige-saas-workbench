// 深路径导入：不要改回 'element-plus'（barrel 入口会阻止 tree-shaking，详见 main.js）
import { ElMessage } from 'element-plus/es/components/message/index';

/**
 * 一键复制到剪贴板
 * ------------------------------------------------------------------
 * 必须做两级降级，否则会让用户「点了没反应」：
 *
 * 方案一 · 异步剪贴板 API（navigator.clipboard.writeText）
 *   最干净，但有两个硬限制：
 *     · 只在**安全上下文**可用（https 或 localhost），http 内网访问时它是 undefined；
 *     · 要求**文档处于聚焦状态**，后台标签页或嵌入 iframe 里会直接抛
 *       `Document is not focused`（实测踩到过）。
 *
 * 方案二 · 临时 textarea + document.execCommand('copy')
 *   老 API 但兼容性最好，且**不要求文档聚焦**。
 *   所以这里不是「浏览器太老才用它」，而是**方案一抛错就立刻用它兜底**。
 *
 * 两级都失败才提示用户手动复制——绝不允许静默失败。
 *
 * @param {string} text 要复制的内容
 * @param {string} okMessage 成功提示语
 * @returns {Promise<boolean>} 是否成功
 */
export async function copyText(text, okMessage = '已复制') {
  const value = String(text ?? '').trim();
  if (!value) {
    ElMessage.warning('没有可复制的内容');
    return false;
  }

  // ---------- 方案一：异步剪贴板 ----------
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      ElMessage.success(okMessage);
      return true;
    } catch {
      // 常见于「文档未聚焦」——不报错，继续走方案二
    }
  }

  // ---------- 方案二：textarea + execCommand 兜底 ----------
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (!ok) throw new Error('浏览器拒绝复制');
    ElMessage.success(okMessage);
    return true;
  } catch (err) {
    ElMessage.error(`复制失败：${err.message || '未知原因'}，请手动选中复制`);
    return false;
  }
}
