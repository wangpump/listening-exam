import {
  CONFIG
} from './config.mjs';


import {
  QUESTIONS,
  SECTION_TITLES
} from './questions.mjs';


import {
  normalizeIdentity,
  retryAsync,
  jitterMs,
  createSubmissionId,
  makeDeadline,
  remainingSeconds
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

    currentQuestion:
      1,

    answers:
      {},

    submitted:
      false,

    submissionId:
      null,

    sectionNumber:
      1,

    sectionPrepEndsAt:
      null,

    sectionStartedAt:
      null
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
    JSON.stringify(state)
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
      ) / 1000
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
  /*
    60人同时进入考试时，
    自动在0—7秒内错峰访问后台。
  */
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
      本考试共五大题、100小题，
      每题1分。
      听力音频由监考老师在教室统一播放，
      学生网页不播放任何声音。
    </p>

    <div class="notice">
      <strong>考试规则：</strong>
      每道题从出现开始只有
      <strong>10秒</strong>，
      这10秒包括听音频和选择答案。
      时间到后答案立即锁定并自动进入下一题。
      每个大题开始前有
      <strong>45秒</strong>
      准备时间。
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


          state.startedAt =
            new Date()
              .toISOString();


          state.currentQuestion =
            1;


          state.sectionNumber =
            1;


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


          renderSectionIntro(
            1
          );

        } catch (error) {
          renderLogin(
            error.message
          );
        }
      }
    );
}


/*
  每个大题开始页面
*/
function renderSectionIntro(
  sectionNumber
) {
  flowToken += 1;

  state.phase =
    'section-intro';

  state.sectionNumber =
    sectionNumber;

  state.sectionPrepEndsAt =
    null;

  state.sectionStartedAt =
    null;

  saveState();


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


  timerBox.classList.add(
    'hidden'
  );


  app.innerHTML = `
    <div class="section-kicker">
      第 ${sectionNumber} / 5 部分
    </div>

    <h2 class="section-title">
      ${escapeHtml(
        SECTION_TITLES[
          sectionNumber - 1
        ]
      )}
    </h2>

    <p class="lead">
      第${sectionNumber}大题共20题
      （第${start}—${end}题），
      每题10秒。
    </p>

    <div class="notice">
      请等待监考老师统一指令。
      点击下面按钮后先进入
      <strong>45秒准备倒计时</strong>，
      倒计时结束后本大题第1题自动出现。
      此后20题连续进行，
      每题10秒，
      中途不停顿。
    </div>

    <div class="identity-summary">
      <div>
        <small>学号</small>
        ${escapeHtml(
          state.identity.studentId
        )}
      </div>

      <div>
        <small>English Name</small>
        ${escapeHtml(
          state.identity.englishName
        )}
      </div>

      <div>
        <small>中文姓名</small>
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
        开始第${sectionNumber}大题（45秒准备）
      </button>
    </div>
  `;


  document
    .getElementById(
      'startSection'
    )
    .addEventListener(
      'click',
      () =>
        beginSectionPrep(
          sectionNumber,
          true
        ),
      {
        once: true
      }
    );
}


/*
  45秒大题准备页面
*/
function renderSectionPrep(
  sectionNumber,
  seconds
) {
  timerBox.classList.add(
    'hidden'
  );

  app.innerHTML = `
    <div class="section-kicker">
      第 ${sectionNumber} / 5 部分 · 准备时间
    </div>

    <h2 class="section-title">
      ${escapeHtml(
        SECTION_TITLES[
          sectionNumber - 1
        ]
      )}
    </h2>

    <div class="notice">
      请准备听监考老师统一播放的音频。
      倒计时结束后，
      第${sectionNumber}大题将自动开始。
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
      秒后开始
    </p>
  `;
}


/*
  开始45秒准备倒计时
*/
async function beginSectionPrep(
  sectionNumber,
  resetDeadline
) {
  const token =
    ++flowToken;


  state.phase =
    'section-prep';


  state.sectionNumber =
    sectionNumber;


  if (
    resetDeadline ||
    !state.sectionPrepEndsAt
  ) {
    state.sectionPrepEndsAt =
      makeDeadline(
        CONFIG
          .SECTION_PREP_SECONDS
      );
  }


  saveState();


  while (
    token ===
    flowToken
  ) {
    const left =
      remainingSeconds(
        state
          .sectionPrepEndsAt
      );


    renderSectionPrep(
      sectionNumber,
      left
    );


    if (
      left <= 0
    ) {
      break;
    }


    await sleep(
      200
    );
  }


  if (
    token !==
    flowToken
  ) {
    return;
  }


  /*
    第1题时间从45秒准备结束的
    绝对时间开始计算。

    即使网页稍有延迟，
    100名/60名学生的时间基准仍一致。
  */
  state.sectionStartedAt =
    Number(
      state.sectionPrepEndsAt
    );


  state.sectionPrepEndsAt =
    null;


  state.phase =
    'question';


  saveState();


  startQuestion(
    state.currentQuestion
  );
}


/*
  显示单题
*/
function renderQuestionShell(
  question,
  secondsLeft
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


  timerBox.classList.add(
    'hidden'
  );


  app.innerHTML = `
    <div class="meta-row">
      <span>
        ${escapeHtml(
          SECTION_TITLES[
            question.section - 1
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
      第 ${question.number} 题 ·
      本大题第 ${withinSection} / 20 题
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
        ${secondsLeft}s
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
                class="option"
                data-answer="${letter}"
              >
                <span class="option-letter">
                  ${letter}
                </span>

                <span>
                  ${escapeHtml(
                    question.options[
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


/*
  计算每一道题的绝对截止时间。

  第1题：大题开始 + 10秒
  第2题：大题开始 + 20秒
  ...
  第20题：大题开始 + 200秒
*/
function questionDeadline(
  question
) {
  const sectionStartNumber =
    (
      question.section -
      1
    ) *
      20 +
    1;


  const withinSection =
    question.number -
    sectionStartNumber +
    1;


  return (
    Number(
      state.sectionStartedAt
    ) +
    withinSection *
      CONFIG.QUESTION_SECONDS *
      1000
  );
}


/*
  单题10秒流程
*/
async function startQuestion(
  number
) {
  if (
    number > 100
  ) {
    return submitExam(
      'completed'
    );
  }


  const question =
    QUESTIONS[
      number - 1
    ];


  const token =
    ++flowToken;


  state.phase =
    'question';


  state.currentQuestion =
    number;


  saveState();


  let left =
    remainingSeconds(
      questionDeadline(
        question
      )
    );


  renderQuestionShell(
    question,
    left
  );


  const buttons =
    [
      ...document
        .querySelectorAll(
          '.option'
        )
    ];


  /*
    如果网页意外刷新，
    当前题已有选择则恢复显示，
    但不会重新获得时间。
  */
  const savedAnswer =
    state.answers[
      number
    ] || '';


  buttons.forEach(
    btn => {
      btn.classList.toggle(
        'selected',
        btn.dataset.answer ===
          savedAnswer
      );


      btn.addEventListener(
        'click',
        () => {
          if (
            token !==
            flowToken
          ) {
            return;
          }


          state.answers[
            number
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


  while (
    token ===
    flowToken
  ) {
    left =
      remainingSeconds(
        questionDeadline(
          question
        )
      );


    const countdown =
      document
        .getElementById(
          'countdown'
        );


    if (
      countdown
    ) {
      countdown.textContent =
        `${left}s`;
    }


    if (
      left <= 0
    ) {
      break;
    }


    await sleep(
      150
    );
  }


  if (
    token !==
    flowToken
  ) {
    return;
  }


  if (
    !(
      number in
      state.answers
    )
  ) {
    state.answers[
      number
    ] =
      '';
  }


  buttons.forEach(
    btn =>
      btn.disabled =
        true
  );


  saveState();


  return advanceAfterQuestion(
    number
  );
}


/*
  自动进入下一题 / 下一大题
*/
async function advanceAfterQuestion(
  number
) {
  if (
    number >= 100
  ) {
    state.currentQuestion =
      101;

    saveState();

    return submitExam(
      'completed'
    );
  }


  const next =
    number + 1;


  state.currentQuestion =
    next;


  saveState();


  /*
    第20、40、60、80题结束以后，
    回到下一大题准备页。

    下一大题不会自动立即开始，
    需要老师再次统一让学生点击按钮，
    然后进行45秒准备倒计时。
  */
  if (
    (
      next - 1
    ) %
      20 ===
    0
  ) {
    return renderSectionIntro(
      Math.floor(
        (
          next - 1
        ) /
          20
      ) + 1
    );
  }


  return startQuestion(
    next
  );
}


/*
  正式交卷
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
      state.identity.studentId,

    englishName:
      state.identity.englishName,

    chineseName:
      state.identity.chineseName,

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
          ] || ''
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


    /*
      60人同时完成第100题时，
      自动在0—12秒内错峰交卷。
    */
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
  交卷失败
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
      网络恢复后点击“重新提交”。
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
        once: true
      }
    );
}


/*
  提交成功页面
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
        <small>English Name</small>
        ${escapeHtml(
          state.identity.englishName
        )}
      </div>

      <div>
        <small>中文姓名</small>
        ${escapeHtml(
          state.identity.chineseName
        )}
      </div>
    </div>
  `;
}


/*
  刷新/重新打开页面后的恢复逻辑。

  45秒和每题10秒都使用绝对截止时间，
  因此刷新网页不会获得额外时间。
*/
function resume() {
  if (
    !state.startedAt ||
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


  if (
    state.phase ===
      'section-intro'
  ) {
    return renderSectionIntro(
      state.sectionNumber ||
      1
    );
  }


  if (
    state.phase ===
      'section-prep'
  ) {
    return beginSectionPrep(
      state.sectionNumber ||
      1,
      false
    );
  }


  if (
    state.phase ===
      'question'
  ) {
    return startQuestion(
      state.currentQuestion
    );
  }


  return renderLogin();
}


/*
  防止考试过程中误关闭页面。
*/
window.addEventListener(
  'beforeunload',
  event => {
    if (
      state.startedAt &&
      !state.submitted
    ) {
      event.preventDefault();

      event.returnValue =
        '';
    }
  }
);


resume();
