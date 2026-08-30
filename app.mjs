import { CONFIG } from './config.mjs';

import {
  QUESTIONS,
  SECTION_TITLES
} from './questions.mjs';

import {
  QUESTION_STARTS_MS,
  EXAM_END_MS,
  answerLockOffsetMs,
  timelinePosition
} from './timing.mjs';

import {
  normalizeIdentity,
  retryAsync,
  jitterMs,
  createSubmissionId
} from './exam-core.mjs';


const app =
  document.getElementById(
    'app'
  );

const timerBox =
  document.getElementById(
    'timerBox'
  );

document
  .getElementById(
    'examTitle'
  )
  .textContent =
    CONFIG.EXAM_TITLE;


let state =
  loadState();

let flowToken =
  0;

let submissionPromise =
  null;


const sleep = (ms) =>
  new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );


const serverConfigured =
  () =>
    /^https:\/\/script\.google\.com\/.+\/exec/
      .test(
        CONFIG
          .GOOGLE_APPS_SCRIPT_URL
      );


function freshState() {
  return {
    version:
      CONFIG.VERSION,

    phase:
      'login',

    identity:
      null,

    startedAt:
      null,

    timelineStartedAt:
      null,

    currentQuestion:
      1,

    answers:
      {},

    submitted:
      false,

    submissionId:
      null,

    sectionNumber:
      1
  };
}


function loadState() {
  try {
    const raw =
      localStorage.getItem(
        CONFIG.STORAGE_KEY
      );

    if (!raw) {
      return freshState();
    }

    const parsed =
      JSON.parse(raw);

    if (
      parsed.version !==
      CONFIG.VERSION
    ) {
      return freshState();
    }

    return {
      ...freshState(),
      ...parsed
    };

  } catch {
    return freshState();
  }
}


function saveState() {
  localStorage.setItem(
    CONFIG.STORAGE_KEY,
    JSON.stringify(
      state
    )
  );
}


function escapeHtml(value) {
  return String(value)
    .replace(
      /[&<>'"]/g,
      c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
      }[c])
    );
}


function elapsedSeconds() {
  if (
    !state.startedAt
  ) {
    return 0;
  }

  return Math.max(
    0,
    Math.floor(
      (
        Date.now() -
        new Date(
          state.startedAt
        ).getTime()
      ) /
      1000
    )
  );
}


function timelineElapsedMs() {
  if (
    !state.timelineStartedAt
  ) {
    return 0;
  }

  return Math.max(
    0,
    Date.now() -
      Number(
        state.timelineStartedAt
      )
  );
}


function makeRequestError(
  message,
  retryable = true
) {
  const error =
    new Error(message);

  error.retryable =
    retryable;

  return error;
}


async function fetchWithTimeout(
  url,
  options,
  timeoutMs =
    CONFIG.REQUEST_TIMEOUT_MS
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      timeoutMs
    );

  try {
    return await fetch(
      url,
      {
        ...options,
        signal:
          controller.signal
      }
    );

  } catch (error) {
    if (
      error?.name ===
      'AbortError'
    ) {
      throw makeRequestError(
        '网络请求超时，请稍候重试'
      );
    }

    throw makeRequestError(
      error?.message ||
      '网络连接失败'
    );

  } finally {
    clearTimeout(
      timer
    );
  }
}


async function postToServer(
  payload,
  {
    maxAttempts =
      CONFIG.SERVER_MAX_ATTEMPTS
  } = {}
) {
  if (
    !serverConfigured()
  ) {
    throw makeRequestError(
      'Google Apps Script 尚未配置',
      false
    );
  }

  return retryAsync(
    async () => {
      const response =
        await fetchWithTimeout(
          CONFIG
            .GOOGLE_APPS_SCRIPT_URL,
          {
            method:
              'POST',

            headers: {
              'Content-Type':
                'text/plain;charset=utf-8'
            },

            body:
              JSON.stringify(
                payload
              ),

            redirect:
              'follow',

            cache:
              'no-store'
          }
        );

      if (
        !response.ok
      ) {
        const retryable =
          response.status ===
            429 ||
          response.status >=
            500;

        throw makeRequestError(
          `服务器响应异常：HTTP ${response.status}`,
          retryable
        );
      }

      let data;

      try {
        data =
          await response.json();

      } catch {
        throw makeRequestError(
          '服务器返回内容无法识别'
        );
      }

      if (
        !data.ok
      ) {
        throw makeRequestError(
          data.message ||
          '服务器拒绝了请求',
          Boolean(
            data.retryable
          )
        );
      }

      return data;
    },
    {
      maxAttempts,

      baseDelayMs:
        650,

      maxDelayMs:
        4500,

      shouldRetry:
        error =>
          error?.retryable !==
          false
    }
  );
}


async function checkDuplicate(
  studentId
) {
  await sleep(
    jitterMs(
      CONFIG
        .START_STAGGER_MAX_MS
    )
  );

  const data =
    await postToServer(
      {
        action:
          'checkAttempt',

        studentId
      },
      {
        maxAttempts:
          5
      }
    );

  return Boolean(
    data.attempted
  );
}


/*
  登录页面
*/
function renderLogin(
  message = ''
) {
  timerBox.classList.add(
    'hidden'
  );

  app.innerHTML = `
    <div class="section-kicker">
      考试登录
    </div>

    <h2 class="section-title">
      ${escapeHtml(
        CONFIG.EXAM_TITLE
      )}
    </h2>

    <p class="lead">
      本考试共五大题、100小题，每题1分。
      听力音频由监考老师统一播放，
      学生网页不播放声音。
    </p>

    <div class="notice">
      <strong>重要：</strong>

      本网页已经按照教师使用的
      “HSK标准音色报题同步正式版”
      完整听力音频逐题校准。

      每道题的显示时间随实际音频长度变化，
      不再固定为10秒。

      每题第二遍播放结束后保留7秒答题，
      再经过约2秒进入下一题；

      每20题结束后自动进入15秒大题间隔，
      然后播放下一大题提示并继续答题。

      整场考试只在第一大题开始前
      点击一次“开始考试”。
    </div>

    ${
      message
        ? `
          <div class="status-error">
            ${escapeHtml(
              message
            )}
          </div>
        `
        : ''
    }

    <form
      id="loginForm"
      class="form-grid"
    >
      <label>
        学号

        <input
          id="studentId"
          autocomplete="off"
          required
        >
      </label>

      <label>
        English Name

        <input
          id="englishName"
          autocomplete="off"
          required
        >
      </label>

      <label>
        中文姓名

        <input
          id="chineseName"
          autocomplete="off"
          required
        >
      </label>

      <button
        class="primary"
        id="startExamBtn"
        type="submit"
      >
        确认信息并进入考试
      </button>
    </form>
  `;


  document
    .getElementById(
      'loginForm'
    )
    .addEventListener(
      'submit',
      async event => {
        event.preventDefault();

        const btn =
          document
            .getElementById(
              'startExamBtn'
            );

        btn.disabled =
          true;

        btn.textContent =
          '正在连接考试服务器…';

        try {
          const identity =
            normalizeIdentity({
              studentId:
                document
                  .getElementById(
                    'studentId'
                  )
                  .value,

              englishName:
                document
                  .getElementById(
                    'englishName'
                  )
                  .value,

              chineseName:
                document
                  .getElementById(
                    'chineseName'
                  )
                  .value
            });


          if (
            await checkDuplicate(
              identity.studentId
            )
          ) {
            throw makeRequestError(
              '该学号已经提交过本次考试，请联系监考老师。',
              false
            );
          }


          state =
            freshState();


          state.phase =
            'section-intro';


          state.identity =
            identity;


          state.submissionId =
            createSubmissionId(
              globalThis.crypto
                ?.randomUUID
                ? () =>
                    globalThis.crypto
                      .randomUUID()
                : null
            );


          saveState();


          renderSectionIntro();

        } catch (error) {
          renderLogin(
            error.message
          );
        }
      }
    );
}


/*
  第一大题开始页面
*/
function renderSectionIntro() {
  flowToken += 1;


  state.phase =
    'section-intro';


  state.sectionNumber =
    1;


  saveState();


  timerBox.classList.add(
    'hidden'
  );


  app.innerHTML = `
    <div class="section-kicker">
      第 1 / 5 部分
    </div>

    <h2 class="section-title">
      ${escapeHtml(
        SECTION_TITLES[0]
      )}
    </h2>

    <p class="lead">
      第一大题为第1—20题。
      开始后整个考试会按照教师播放的完整音频自动推进。
    </p>

    <div class="notice">
      <strong>同步方法：</strong>

      请等待监考老师统一倒数。

      老师开始播放
      <strong>
        “期末听力考试_100题_HSK标准音色_报题同步正式版.mp3”
      </strong>
      的同时，

      全班学生点击下面的
      “开始考试”。

      音频开头依次包含“现在开始答题”、
      10秒准备、“现在开始第一大题”
      和2秒衔接时间。

      此后第1—100题、
      7秒答题时间、2秒普通题间隔以及
      每大题之间的15秒间隔都会自动同步，

      不再点击任何按钮。
    </div>

    <div class="identity-summary">
      <div>
        <small>学号</small>

        ${escapeHtml(
          state.identity.studentId
        )}
      </div>

      <div>
        <small>
          English Name
        </small>

        ${escapeHtml(
          state.identity.englishName
        )}
      </div>

      <div>
        <small>
          中文姓名
        </small>

        ${escapeHtml(
          state.identity.chineseName
        )}
      </div>
    </div>

    <div class="actions">
      <button
        id="startSection"
        class="primary"
      >
        开始考试
      </button>
    </div>
  `;


  document
    .getElementById(
      'startSection'
    )
    .addEventListener(
      'click',
      () => {
        const now =
          Date.now();


        state.timelineStartedAt =
          now;


        state.startedAt =
          new Date(
            now
          )
            .toISOString();


        state.phase =
          'running';


        saveState();


        runTimeline();
      },
      {
        once:
          true
      }
    );
}


/*
  大题准备页面
*/
function renderPrep(
  sectionNumber,
  seconds,
  initial = false
) {
  timerBox.classList.add(
    'hidden'
  );


  const start =
    (
      sectionNumber -
      1
    ) *
      20 +
    1;


  const end =
    sectionNumber *
    20;


  app.innerHTML = `
    <div class="section-kicker">
      第 ${sectionNumber} / 5 部分
      · 准备时间
    </div>

    <h2 class="section-title">
      ${escapeHtml(
        SECTION_TITLES[
          sectionNumber - 1
        ]
      )}
    </h2>

    <div class="notice">
      ${
        initial
          ? `
            同步音频已经开始播放，
            目前为开场准备时间。
          `
          : `
            第${sectionNumber}大题为
            第${start}—${end}题。
          `
      }

      倒计时结束后，
      本大题将自动开始，

      无需点击任何按钮。
    </div>

    <div
      class="audio-status"
      style="
        justify-content:center;
        text-align:center;
        padding:28px 0;
      "
    >
      <strong
        id="sectionCountdown"
        style="font-size:48px;"
      >
        ${seconds}
      </strong>
    </div>

    <p
      class="lead"
      style="text-align:center;"
    >
      秒后自动开始
    </p>
  `;
}


/*
  显示正在答题的页面
*/
function renderQuestion(
  question,
  answerSecondsLeft
) {
  const sectionStart =
    (
      question.section -
      1
    ) *
      20 +
    1;


  const withinSection =
    question.number -
    sectionStart +
    1;


  const progressPct =
    (
      (
        question.number -
        1
      ) /
      QUESTIONS.length
    ) *
    100;


  const savedAnswer =
    state.answers[
      question.number
    ] ||
    '';


  timerBox.classList.add(
    'hidden'
  );


  app.innerHTML = `
    <div class="meta-row">
      <span>
        ${escapeHtml(
          SECTION_TITLES[
            question.section -
            1
          ]
        )}
      </span>

      <strong>
        ${question.number} / 100
      </strong>
    </div>

    <div class="progress">
      <div
        style="width:${progressPct}%"
      ></div>
    </div>

    <div class="question-number">
      第 ${question.number} 题
      ·
      本大题第
      ${withinSection} / 20
      题
    </div>

    <div class="prompt">
      ${escapeHtml(
        question.prompt
      )}
    </div>

    <div class="audio-status">
      <strong>
        请选择答案
      </strong>

      <span
        id="countdown"
        class="countdown"
      >
        ${answerSecondsLeft}s
      </span>
    </div>

    <div
      id="options"
      class="options"
    >
      ${
        [
          'A',
          'B',
          'C'
        ]
          .map(
            letter => `
              <button
                class="option ${
                  savedAnswer ===
                  letter
                    ? 'selected'
                    : ''
                }"
                data-answer="${letter}"
              >
                <span
                  class="option-letter"
                >
                  ${letter}
                </span>

                <span>
                  ${escapeHtml(
                    question
                      .options[
                        letter
                      ]
                  )}
                </span>
              </button>
            `
          )
          .join('')
      }
    </div>
  `;


  const buttons =
    [
      ...document
        .querySelectorAll(
          '.option'
        )
    ];


  buttons.forEach(
    btn => {
      btn.addEventListener(
        'click',
        () => {
          state.answers[
            question.number
          ] =
            btn.dataset.answer;


          saveState();


          buttons.forEach(
            b =>
              b.classList.toggle(
                'selected',
                b === btn
              )
          );
        }
      );
    }
  );
}


/*
  普通2秒题间隔：
  答案锁定，不再允许修改。
*/
function renderLockedQuestion(
  question,
  secondsToNext
) {
  const sectionStart =
    (
      question.section -
      1
    ) *
      20 +
    1;


  const withinSection =
    question.number -
    sectionStart +
    1;


  const progressPct =
    (
      (
        question.number -
        1
      ) /
      QUESTIONS.length
    ) *
    100;


  const savedAnswer =
    state.answers[
      question.number
    ] ||
    '';


  timerBox.classList.add(
    'hidden'
  );


  app.innerHTML = `
    <div class="meta-row">
      <span>
        ${escapeHtml(
          SECTION_TITLES[
            question.section -
            1
          ]
        )}
      </span>

      <strong>
        ${question.number} / 100
      </strong>
    </div>

    <div class="progress">
      <div
        style="width:${progressPct}%"
      ></div>
    </div>

    <div class="question-number">
      第 ${question.number} 题
      ·
      本大题第
      ${withinSection} / 20
      题
    </div>

    <div class="prompt">
      ${escapeHtml(
        question.prompt
      )}
    </div>

    <div class="audio-status">
      <strong>
        答案已锁定
      </strong>

      <span
        id="gapCountdown"
        class="countdown"
      >
        ${secondsToNext}s
      </span>
    </div>

    <div class="options">
      ${
        [
          'A',
          'B',
          'C'
        ]
          .map(
            letter => `
              <button
                class="option ${
                  savedAnswer ===
                  letter
                    ? 'selected'
                    : ''
                }"
                disabled
              >
                <span
                  class="option-letter"
                >
                  ${letter}
                </span>

                <span>
                  ${escapeHtml(
                    question
                      .options[
                        letter
                      ]
                  )}
                </span>
              </button>
            `
          )
          .join('')
      }
    </div>
  `;
}


function ceilSeconds(ms) {
  return Math.max(
    0,
    Math.ceil(
      ms / 1000
    )
  );
}


/*
  整个考试的核心同步时间轴
*/
async function runTimeline() {
  const token =
    ++flowToken;


  let viewKey =
    '';


  while (
    token ===
    flowToken
  ) {
    const elapsed =
      timelineElapsedMs();


    const position =
      timelinePosition(
        elapsed
      );


    /*
      整个音频结束：
      自动交卷
    */
    if (
      position.kind ===
      'finished'
    ) {
      state.currentQuestion =
        101;


      state.phase =
        'submitting';


      saveState();


      return submitExam(
        'completed'
      );
    }


    /*
      开场提示与第一大题准备阶段
    */
    if (
      position.kind ===
      'initial-prep'
    ) {
      const key =
        'initial-prep';


      const remaining =
        ceilSeconds(
          QUESTION_STARTS_MS[0] -
          elapsed
        );


      if (
        viewKey !== key
      ) {
        state.phase =
          'initial-prep';


        state.currentQuestion =
          1;


        state.sectionNumber =
          1;


        saveState();


        renderPrep(
          1,
          remaining,
          true
        );


        viewKey =
          key;

      } else {
        const el =
          document
            .getElementById(
              'sectionCountdown'
            );


        if (
          el
        ) {
          el.textContent =
            remaining;
        }
      }
    }


    /*
      正常答题阶段
    */
    if (
      position.kind ===
      'question'
    ) {
      const q =
        position.question;


      const key =
        `question-${q}`;


      const remaining =
        ceilSeconds(
          answerLockOffsetMs(q) -
          elapsed
        );


      if (
        viewKey !== key
      ) {
        state.phase =
          'question';


        state.currentQuestion =
          q;


        state.sectionNumber =
          position.section;


        if (
          !(
            q in
            state.answers
          )
        ) {
          state.answers[q] =
            '';
        }


        saveState();


        renderQuestion(
          QUESTIONS[
            q - 1
          ],
          remaining
        );


        viewKey =
          key;

      } else {
        const el =
          document
            .getElementById(
              'countdown'
            );


        if (
          el
        ) {
          el.textContent =
            `${remaining}s`;
        }
      }
    }


    /*
      普通题后的2秒间隔
    */
    if (
      position.kind ===
      'gap'
    ) {
      const q =
        position.question;


      const key =
        `gap-${q}`;


      const remaining =
        ceilSeconds(
          QUESTION_STARTS_MS[q] -
          elapsed
        );


      if (
        viewKey !== key
      ) {
        state.phase =
          'gap';


        state.currentQuestion =
          q;


        state.sectionNumber =
          position.section;


        saveState();


        renderLockedQuestion(
          QUESTIONS[
            q - 1
          ],
          remaining
        );


        viewKey =
          key;

      } else {
        const el =
          document
            .getElementById(
              'gapCountdown'
            );


        if (
          el
        ) {
          el.textContent =
            `${remaining}s`;
        }
      }
    }


    /*
      第20、40、60、80题后：
      进入15秒下一大题准备。
    */
    if (
      position.kind ===
      'section-prep'
    ) {
      const nextQuestion =
        position.question;


      const nextSection =
        position.section;


      const key =
        `section-prep-${nextSection}`;


      const remaining =
        ceilSeconds(
          QUESTION_STARTS_MS[
            nextQuestion -
            1
          ] -
          elapsed
        );


      if (
        viewKey !== key
      ) {
        state.phase =
          'section-prep';


        state.currentQuestion =
          nextQuestion;


        state.sectionNumber =
          nextSection;


        saveState();


        renderPrep(
          nextSection,
          remaining,
          false
        );


        viewKey =
          key;

      } else {
        const el =
          document
            .getElementById(
              'sectionCountdown'
            );


        if (
          el
        ) {
          el.textContent =
            remaining;
        }
      }
    }


    /*
      每100毫秒检查一次真实时间。
      页面卡顿或刷新不会重新计算考试时间。
    */
    await sleep(
      100
    );
  }
}


/*
  提交试卷
*/
async function performSubmission(
  reason
) {
  state.phase =
    'submitting';


  if (
    !state.submissionId
  ) {
    state.submissionId =
      createSubmissionId(
        globalThis.crypto
          ?.randomUUID
          ? () =>
              globalThis.crypto
                .randomUUID()
          : null
      );
  }


  saveState();


  timerBox.classList.add(
    'hidden'
  );


  app.innerHTML = `
    <div class="section-kicker">
      正在交卷
    </div>

    <h2 class="section-title">
      考试已结束
    </h2>

    <p class="lead">
      正在把答卷写入教师成绩表，
      请不要关闭页面。
    </p>
  `;


  const payload = {
    action:
      'submit',

    submissionId:
      state.submissionId,

    version:
      CONFIG.VERSION,

    reason,

    studentId:
      state.identity
        .studentId,

    englishName:
      state.identity
        .englishName,

    chineseName:
      state.identity
        .chineseName,

    startedAt:
      state.startedAt,

    completedAt:
      new Date()
        .toISOString(),

    durationSeconds:
      elapsedSeconds(),

    answers:
      QUESTIONS.map(
        q =>
          state.answers[
            q.number
          ] ||
          ''
      ),

    userAgent:
      navigator.userAgent
  };


  try {
    const firstAttempt =
      reason !==
        'retry-submit' &&
      reason !==
        'resume-submit';


    if (
      firstAttempt
    ) {
      await sleep(
        jitterMs(
          CONFIG
            .SUBMIT_STAGGER_MAX_MS
        )
      );
    }


    const result =
      await postToServer(
        payload,
        {
          maxAttempts:
            5
        }
      );


    state.submitted =
      true;


    state.submissionId =
      result.submissionId ||
      state.submissionId;


    state.phase =
      'finished';


    saveState();


    renderFinished();

  } catch (error) {
    state.phase =
      'submission-error';


    saveState();


    renderSubmissionError(
      error.message
    );
  }
}


function submitExam(
  reason
) {
  if (
    submissionPromise
  ) {
    return submissionPromise;
  }


  submissionPromise =
    performSubmission(
      reason
    )
      .finally(
        () => {
          submissionPromise =
            null;
        }
      );


  return submissionPromise;
}


/*
  提交失败
*/
function renderSubmissionError(
  message
) {
  app.innerHTML = `
    <div class="status-error">
      <strong>
        答卷尚未成功上传
      </strong>

      <br>

      ${escapeHtml(
        message
      )}
    </div>

    <p class="lead">
      你的答案仍保存在当前浏览器中。

      请不要重新开始考试，

      网络恢复后点击
      “重新提交”。
    </p>

    <div class="actions">
      <button
        id="retrySubmit"
        class="primary"
      >
        重新提交答卷
      </button>
    </div>
  `;


  document
    .getElementById(
      'retrySubmit'
    )
    .addEventListener(
      'click',
      () =>
        submitExam(
          'retry-submit'
        ),
      {
        once:
          true
      }
    );
}


/*
  已完成
*/
function renderFinished() {
  state.phase =
    'finished';


  saveState();


  timerBox.classList.add(
    'hidden'
  );


  app.innerHTML = `
    <div class="section-kicker">
      SUBMITTED
    </div>

    <h2 class="section-title">
      考试结束
    </h2>

    <div class="status-success">
      <strong>
        你的试卷已经成功提交。
      </strong>

      <br>

      成绩已发送到教师成绩表，
      请关闭本页面。
    </div>

    <div class="identity-summary">
      <div>
        <small>学号</small>

        ${escapeHtml(
          state.identity.studentId
        )}
      </div>

      <div>
        <small>
          English Name
        </small>

        ${escapeHtml(
          state.identity.englishName
        )}
      </div>

      <div>
        <small>
          中文姓名
        </small>

        ${escapeHtml(
          state.identity.chineseName
        )}
      </div>
    </div>
  `;
}


/*
  刷新页面恢复
*/
function resume() {
  if (
    !state.identity ||
    state.phase ===
      'login'
  ) {
    return renderLogin();
  }


  if (
    state.submitted ||
    state.phase ===
      'finished'
  ) {
    return renderFinished();
  }


  if (
    state.phase ===
      'submission-error' ||
    state.phase ===
      'submitting'
  ) {
    return submitExam(
      'resume-submit'
    );
  }


  /*
    尚未正式开始考试。
  */
  if (
    !state.timelineStartedAt
  ) {
    return renderSectionIntro();
  }


  /*
    一旦开始考试，
    刷新后继续跟随同一个绝对音频时间轴，
    绝不重新计时。
  */
  return runTimeline();
}


/*
  防止考试中误关闭页面
*/
window.addEventListener(
  'beforeunload',
  event => {
    if (
      state.identity &&
      !state.submitted
    ) {
      event.preventDefault();

      event.returnValue =
        '';
    }
  }
);


/*
  启动
*/
resume();
