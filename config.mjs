export const CONFIG = {
  EXAM_TITLE: '对外汉语初级期末听力考试',

  // 每题总时间：听老师统一播放 + 选择答案，共10秒
  QUESTION_SECONDS: 10,

  // 每个大题开始前准备时间
  SECTION_PREP_SECONDS: 45,

  // 最多60人同时登录时随机错峰
  START_STAGGER_MAX_MS: 7000,

  // 最多60人同时交卷时随机错峰
  SUBMIT_STAGGER_MAX_MS: 12000,

  // 后台请求失败时自动重试
  SERVER_MAX_ATTEMPTS: 5,
  REQUEST_TIMEOUT_MS: 20000,

  GOOGLE_APPS_SCRIPT_URL:
    'https://script.google.com/macros/s/AKfycbytKVM6qE11BpRjK6jixJlzLrwXSbu7hehSD5U90FtQwmEK8NJ6PeymR6zh9gorohHVmQ/exec',

  STORAGE_KEY: 'pkru-listening-final-v3-noaudio',
  VERSION: '3.0.0'
};
