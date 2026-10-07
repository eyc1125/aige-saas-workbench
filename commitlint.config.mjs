/**
 * commitlint 配置
 * ------------------------------------------------------------------
 * 目的不是「管格式」，而是让 git log 能被机器读懂：
 *   · 一眼看出这次是功能、修复还是性能（type）
 *   · 按模块查历史（scope），例如 `git log --grep '^feat(metrics)'`
 *
 * 为什么用 conventional：它是 GitHub 生态里事实上的标准，
 * Dependabot / release 工具 / changelog 生成器都认它。
 *
 * 本项目的实际写法（和历史提交一致）：
 *   feat(metrics): CPU/负载/运行时长改为直读 /proc，资源趋势落库 30 天
 *   └ type └ scope  └ 主语（中文，说清「改了什么、为什么」）
 *
 * 校验放在 CI 而不是 husky 本地钩子：
 *   钩子会改 .git/hooks、还要每个人装一次；CI 校验对所有协作者、
 *   包括网页端提交和 Dependabot 都生效，且不干扰本地快速提交。
 */
export default {
  extends: ['@commitlint/config-conventional'],

  rules: {
    // 中文信息按「字符」计数，100 个中文字符已经很够用
    'header-max-length': [2, 'always', 100],

    // 正文常常要粘一段报错或路径，放宽到 120
    'body-max-line-length': [2, 'always', 120],

    // 结尾不要句号：中英文句号都禁（config-conventional 默认只禁英文的）
    'subject-full-stop': [2, 'never', ['.', '。']],

    // 与仓库实际使用的类型对齐
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'perf',
        'refactor',
        'docs',
        'style',
        'test',
        'build',
        'ci',
        'chore',
        'revert',
      ],
    ],

    // scope 允许留空（例如纯 chore），但写了就必须是小写短标识
    'scope-case': [2, 'always', 'lower-case'],

    'subject-case': [0],
  },
};
