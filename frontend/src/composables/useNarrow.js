import { onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * 窄屏判定
 * ------------------------------------------------------------------
 * 表格页在手机上不用「横向拖动」的方案：320~640px 的屏宽下，
 * 一个 6 列表格横过来必然把操作列压成一团、按钮互相重叠。
 * 后台管理在手机上的通行做法是「一行数据 = 一张卡片」，
 * 所以窄屏时把 el-table 换成卡片列表（见 index.css 的 .cards 样式）。
 *
 * 用 matchMedia 而不是监听 resize：matchMedia 只在跨过断点时触发一次，
 * 不会在拖动窗口时反复重渲染。
 *
 * @param {number} breakpoint 断点像素，默认 640
 * @returns {import('vue').Ref<boolean>} 是否为窄屏
 */
export function useNarrow(breakpoint = 640) {
  const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
  const narrow = ref(mq.matches);

  const onChange = (e) => {
    narrow.value = e.matches;
  };

  onMounted(() => {
    narrow.value = mq.matches; // 挂载时再取一次，避免预渲染与真实环境不一致
    mq.addEventListener('change', onChange);
  });

  onBeforeUnmount(() => mq.removeEventListener('change', onChange));

  return narrow;
}
