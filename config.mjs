export const CONFIG = {
  EXAM_TITLE: '对外汉语初级期末听力考试',

  // 每个大题之间的准备时间，与同步版教师音频一致。
  SECTION_PREP_SECONDS: 15,

  // 普通题之间的题间隔，与同步版教师音频一致。
  NORMAL_GAP_SECONDS: 2,

  // 最多60人同时登录时随机错峰。
  START_STAGGER_MAX_MS: 7000,

  // 最多60人同时交卷时随机错峰。
  SUBMIT_STAGGER_MAX_MS: 12000,

  SERVER_MAX_ATTEMPTS: 5,
  REQUEST_TIMEOUT_MS: 20000,

  GOOGLE_APPS_SCRIPT_URL:
    'https://script.google.com/macros/s/AKfycbytKVM6qE11BpRjK6jixJlzLrwXSbu7hehSD5U90FtQwmEK8NJ6PeymR6zh9gorohHVmQ/exec',

  // 新版使用独立存储，避免旧的固定10秒版本干扰。
  STORAGE_KEY: 'pkru-listening-final-v4-audio-sync',

  VERSION: '4.0.0'
};
