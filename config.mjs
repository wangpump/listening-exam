export const CONFIG = {
  EXAM_TITLE: '对外汉语初级期末听力考试',

  // 考试总时长
  EXAM_MINUTES: 60,

  // 第二遍录音结束后的答题时间
  ANSWER_SECONDS: 5,

  // 两遍录音之间的停顿
  GAP_BETWEEN_PLAYS_MS: 900,

  // 每题结束到下一题开始之间的停顿
  GAP_BETWEEN_QUESTIONS_MS: 650,

  // 最多60人同时登录时，随机错峰 0—7 秒
  START_STAGGER_MAX_MS: 7000,

  // 最多60人同时交卷时，随机错峰 0—12 秒
  SUBMIT_STAGGER_MAX_MS: 12000,

  // Google Apps Script 请求失败时最多自动尝试次数
  SERVER_MAX_ATTEMPTS: 5,

  // 单次后台请求最长等待时间
  REQUEST_TIMEOUT_MS: 20000,

  // 每个大题预加载音频时，同时下载的最大数量
  AUDIO_PRELOAD_CONCURRENCY: 4,

  // 单个音频下载失败时最多重试次数
  AUDIO_FETCH_ATTEMPTS: 4,

  GOOGLE_APPS_SCRIPT_URL:
    'https://script.google.com/macros/s/AKfycbytKVM6qE11BpRjK6jixJlzLrwXSbu7hehSD5U90FtQwmEK8NJ6PeymR6zh9gorohHVmQ/exec',

  // v2 使用新的本地存储键，避免旧版测试记录影响正式考试
  STORAGE_KEY: 'pkru-listening-final-v2',

  VERSION: '2.0.0'
};
