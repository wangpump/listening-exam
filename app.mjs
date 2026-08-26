import { CONFIG } from './config.mjs';

import {
  QUESTIONS,
  SECTION_TITLES
} from './questions.mjs';

import {
  normalizeIdentity,
  playExactlyTwice,
  retryAsync,
  getSectionQuestions,
  jitterMs,
  createSubmissionId
} from './exam-core.mjs';


const app =
  document.getElementById('app');

const timerBox =
  document.getElementById('timerBox');

const timerEl =
  document.getElementById('timer');


document.getElementById(
  'examTitle'
).textContent = CONFIG.EXAM_TITLE;


let state = loadState();

let timerHandle = null;

let activeAudio = null;

let questionRunToken = 0;

let submissionPromise = null;


/*
 questionNumber -> Blob object URL

 每个大题开始之前，
 音频先下载到浏览器内存。

 正式播放时，
 不再依赖实时网络。
*/
const audioCache = new Map();


const sleep = (ms) =>
  new Promise(
    resolve => setTimeout(resolve, ms)
  );


const serverConfigured = () =>
  /^https:\/\/script\.google\.com\/.+\/exec/
    .test(
      CONFIG.GOOGLE_APPS_SCRIPT_URL
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

    played:
      {},

    submitted:
      false,

    submissionId:
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


function startTimer() {

  timerBox.classList.remove(
    'hidden'
  );


  if (timerHandle) {

    clearInterval(
      timerHandle
    );

  }


  const tick = async () => {

    const elapsed =
      Math.floor(
        (
          Date.now() -
          new Date(
            state.startedAt
          ).getTime()
        ) / 1000
      );


    const remaining =
      Math.max(
        0,
        CONFIG.EXAM_MINUTES *
        60 -
        elapsed
      );


    const mm =
      String(
        Math.floor(
          remaining / 60
        )
      ).padStart(
        2,
        '0'
      );


    const ss =
      String(
        remaining % 60
      ).padStart(
        2,
        '0'
      );


    timerEl.textContent =
      `${mm}:${ss}`;


    if (
      remaining <= 0
    ) {

      clearInterval(
        timerHandle
      );

      timerHandle =
        null;


      questionRunToken += 1;


      if (
        activeAudio
      ) {

        activeAudio.pause();

        activeAudio =
          null;

      }


      await submitExam(
        'time-expired'
      );

    }

  };


  tick();


  timerHandle =
    setInterval(
      tick,
      1000
    );

}


function elapsedSeconds() {

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
          response.status === 429 ||
          response.status >= 500;


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

  if (
    !serverConfigured()
  ) {

    return false;

  }


  /*
   60人如果同时点击开始考试，
   自动随机分散到约7秒内。
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
        maxAttempts: 5
      }
    );


  return Boolean(
    data.attempted
  );

}


async function loadAudioBlobWithRetry(
  question
) {

  if (
    audioCache.has(
      question.number
    )
  ) {

    return audioCache.get(
      question.number
    );

  }


  const objectUrl =
    await retryAsync(

      async () => {

        const response =
          await fetchWithTimeout(

            question.audio,

            {

              method:
                'GET',

              cache:
                'force-cache',

              credentials:
                'same-origin'

            },

            15000

          );


        if (
          !response.ok
        ) {

          throw makeRequestError(

            `第${question.number}题音频下载失败：HTTP ${response.status}`

          );

        }


        const blob =
          await response.blob();


        if (
          !blob ||
          blob.size < 500
        ) {

          throw makeRequestError(

            `第${question.number}题音频文件无效`

          );

        }


        return URL.createObjectURL(
          blob
        );

      },

      {

        maxAttempts:
          CONFIG
            .AUDIO_FETCH_ATTEMPTS,

        baseDelayMs:
          450,

        maxDelayMs:
          3200

      }

    );


  audioCache.set(
    question.number,
    objectUrl
  );


  return objectUrl;

}


async function runWithConcurrency(
  items,
  limit,
  worker
) {

  let cursor = 0;


  const workers =
    Array.from(
      {
        length:
          Math.min(
            limit,
            items.length
          )
      },
      async () => {

        while (
          cursor <
          items.length
        ) {

          const index =
            cursor;

          cursor += 1;


          await worker(
            items[index],
            index
          );

        }

      }
    );


  await Promise.all(
    workers
  );

}


async function preloadSectionAudio(
  sectionNumber,
  onProgress = () => {}
) {

  const questions =
    getSectionQuestions(
      QUESTIONS,
      sectionNumber
    );


  let completed =
    questions
      .filter(
        q =>
          audioCache.has(
            q.number
          )
      )
      .length;


  onProgress(
    completed,
    questions.length
  );


  const pending =
    questions.filter(
      q =>
        !audioCache.has(
          q.number
        )
    );


  await runWithConcurrency(

    pending,

    CONFIG
      .AUDIO_PRELOAD_CONCURRENCY,

    async question => {

      await loadAudioBlobWithRetry(
        question
      );


      completed += 1;


      onProgress(
        completed,
        questions.length
      );

    }

  );


  return true;

}


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
      每题1分，满分100分。
      每道题的录音只播放两遍；
      第二遍结束后只有5秒作答时间。
    </p>

    <div class="notice">
      <strong>重要：</strong>
      考试开始后请勿刷新、关闭页面或切换设备。
      系统会在每个大题开始前先完成音频缓存，
      正式播放时不再依赖即时下载。
    </div>

    ${
      message
        ? `
          <div class="status-error">
            ${escapeHtml(message)}
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
        确认信息并开始考试
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
          document.getElementById(
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


          startTimer();


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


function renderSectionIntro(
  sectionNumber
) {

  state.phase =
    'section-intro';


  saveState();


  const start =
    (
      sectionNumber -
      1
    ) * 20 + 1;


  const end =
    sectionNumber * 20;


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
      每题1分。
    </p>

    <div class="notice">
      系统正在准备本大题20段听力。
      全部缓存完成后才可开始。
      正式考试时，每题仍然只播放
      <strong>两遍</strong>，
      第二遍结束后开放选项并倒计时
      <strong>5秒</strong>。
    </div>

    <div
      id="preloadStatus"
      class="audio-status"
    >
      <strong>
        正在准备音频 0/20
      </strong>
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
        disabled
      >
        音频准备中…
      </button>

      <button
        id="retryPreload"
        class="secondary hidden"
        type="button"
      >
        重新准备音频
      </button>

    </div>

  `;


  const startButton =
    document.getElementById(
      'startSection'
    );


  const retryButton =
    document.getElementById(
      'retryPreload'
    );


  const statusBox =
    document.getElementById(
      'preloadStatus'
    );


  const prepare =
    async () => {

      startButton.disabled =
        true;


      startButton.textContent =
        '音频准备中…';


      retryButton.classList.add(
        'hidden'
      );


      try {

        await preloadSectionAudio(

          sectionNumber,

          (
            done,
            total
          ) => {

            statusBox.innerHTML =
              `<strong>正在准备音频 ${done}/${total}</strong>`;

          }

        );


        statusBox.innerHTML =
          '<strong>音频准备完成，可以开始本大题。</strong>';


        startButton.disabled =
          false;


        startButton.textContent =
          `开始第${sectionNumber}大题`;

      } catch (error) {

        statusBox.innerHTML =
          `<strong>音频准备失败</strong><br>${escapeHtml(error.message)}。此时尚未播放任何题目，可以安全重试。`;


        retryButton
          .classList
          .remove(
            'hidden'
          );

      }

    };


  retryButton
    .addEventListener(
      'click',
      prepare
    );


  startButton
    .addEventListener(

      'click',

      () => {

        if (
          startButton.disabled
        ) {

          return;

        }


        state.phase =
          'question';


        saveState();


        startQuestion(
          state.currentQuestion
        );

      },

      {
        once: true
      }

    );


  prepare();

}


function renderQuestionShell(
  question
) {

  const sectionStart =
    (
      question.section -
      1
    ) * 20 + 1;


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

      <strong id="audioStatus">
        准备播放
      </strong>

      <span
        id="countdown"
        class="countdown"
      ></span>

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
                disabled
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


async function playAudioOnce(
  question,
  passNumber,
  token
) {

  if (
    token !==
    questionRunToken
  ) {

    return;

  }


  const cachedUrl =
    audioCache.get(
      question.number
    );


  if (
    !cachedUrl
  ) {

    throw makeRequestError(

      `第${question.number}题音频尚未缓存`,

      false

    );

  }


  const status =
    document.getElementById(
      'audioStatus'
    );


  status.textContent =
    `第 ${passNumber} 遍播放中`;


  activeAudio =
    new Audio(
      cachedUrl
    );


  activeAudio.preload =
    'auto';


  activeAudio.playsInline =
    true;


  await new Promise(
    (
      resolve,
      reject
    ) => {

      const audio =
        activeAudio;


      let playbackStarted =
        false;


      const cleanup =
        () => {

          audio
            .removeEventListener(
              'ended',
              onEnded
            );


          audio
            .removeEventListener(
              'error',
              onError
            );

        };


      const onEnded =
        () => {

          cleanup();

          resolve();

        };


      const onError =
        () => {

          cleanup();


          reject(

            makeRequestError(

              playbackStarted

                ? `第${question.number}题播放过程中发生设备音频错误`

                : `第${question.number}题音频无法启动`,

              false

            )

          );

        };


      audio.addEventListener(
        'ended',
        onEnded,
        {
          once: true
        }
      );


      audio.addEventListener(
        'error',
        onError,
        {
          once: true
        }
      );


      audio
        .play()

        .then(
          () => {

            playbackStarted =
              true;


            /*
             只有真正开始播放后，
             才标记该题已经使用播放机会。
            */
            if (
              passNumber === 1 &&
              !state.played[
                question.number
              ]
            ) {

              state.played[
                question.number
              ] =
                true;


              saveState();

            }

          }
        )

        .catch(
          onError
        );

    }
  );


  activeAudio =
    null;


  if (
    passNumber === 1
  ) {

    await sleep(
      CONFIG
        .GAP_BETWEEN_PLAYS_MS
    );

  }

}


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


  state.phase =
    'question';


  state.currentQuestion =
    number;


  renderQuestionShell(
    question
  );


  /*
   如果已经真正播放过，
   刷新页面不会获得重新播放机会。
  */
  if (
    state.played[
      number
    ]
  ) {

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


    saveState();


    await sleep(
      250
    );


    return advanceAfterQuestion(
      number
    );

  }


  const token =
    ++questionRunToken;


  try {

    /*
     理论上进入本大题时
     已经缓存成功。

     这里保留一道安全保护。
    */
    if (
      !audioCache.has(
        number
      )
    ) {

      await loadAudioBlobWithRetry(
        question
      );

    }


    await playExactlyTwice(

      pass =>
        playAudioOnce(
          question,
          pass,
          token
        )

    );


    if (
      token !==
      questionRunToken
    ) {

      return;

    }


    await openAnswerWindow(
      question,
      token
    );

  } catch (error) {

    const spent =
      Boolean(
        state.played[
          number
        ]
      );


    app.innerHTML = `

      <div class="status-error">

        <strong>
          音频播放异常
        </strong>

        <br>

        ${escapeHtml(
          error.message
        )}。

        ${
          spent

            ? '该题已经开始过播放，为保证公平不会重新播放。'

            : '该题尚未开始发声，可以联系监考老师处理。'
        }

      </div>

      <p class="lead">
        题号：
        ${question.number}
      </p>

    `;

  }

}


async function openAnswerWindow(
  question,
  token
) {

  const status =
    document.getElementById(
      'audioStatus'
    );


  const countdown =
    document.getElementById(
      'countdown'
    );


  const buttons =
    [
      ...document.querySelectorAll(
        '.option'
      )
    ];


  status.textContent =
    '请选择答案';


  buttons.forEach(
    btn => {

      btn.disabled =
        false;


      btn.addEventListener(

        'click',

        () => {

          const answer =
            btn.dataset.answer;


          state.answers[
            question.number
          ] =
            answer;


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


  for (
    let seconds =
      CONFIG.ANSWER_SECONDS;

    seconds >= 1;

    seconds -= 1
  ) {

    if (
      token !==
      questionRunToken
    ) {

      return;

    }


    countdown.textContent =
      `${seconds}s`;


    await sleep(
      1000
    );

  }


  if (
    !(
      question.number in
      state.answers
    )
  ) {

    state.answers[
      question.number
    ] =
      '';

  }


  buttons.forEach(
    btn =>
      btn.disabled =
        true
  );


  status.textContent =
    '答案已锁定';


  countdown.textContent =
    '';


  saveState();


  await sleep(
    CONFIG
      .GAP_BETWEEN_QUESTIONS_MS
  );


  return advanceAfterQuestion(
    question.number
  );

}


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


  const nextSection =
    Math.floor(
      (
        next - 1
      ) /
      20
    ) +
    1;


  /*
   21、41、61、81
   进入下一大题准备页面。
  */
  if (
    (
      next - 1
    ) %
    20 ===
    0
  ) {

    return renderSectionIntro(
      nextSection
    );

  }


  return startQuestion(
    next
  );

}


async function performSubmission(
  reason
) {

  state.phase =
    'submitting';


  /*
   submissionId整个考试过程中固定，
   即使网络重试，也不会产生新的答卷编号。
  */
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


  if (
    timerHandle
  ) {

    clearInterval(
      timerHandle
    );

  }


  timerHandle =
    null;


  timerBox.classList.remove(
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
      系统正在安全排队提交答卷。
      60人同时交卷时会自动错峰，
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
          ] ||
          ''
      ),

    userAgent:
      navigator.userAgent

  };


  try {

    if (
      !serverConfigured()
    ) {

      throw makeRequestError(

        '当前网页尚未配置 Google Apps Script 地址。',

        false

      );

    }


    /*
     第一次交卷才随机错峰。

     如果学生已经进入
     手动“重新提交”，
     不再重复等待。
    */
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
          maxAttempts: 5
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

  /*
   防止同一浏览器在同一时间
   启动两个交卷请求。
  */
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

      你的100题答案和固定提交编号
      仍保存在当前浏览器中。

      请不要重新考试；

      网络恢复后点击“重新提交”，
      系统会按同一份答卷继续提交，
      不会重复记分。

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


function renderFinished() {

  state.phase =
    'finished';


  saveState();


  if (
    timerHandle
  ) {

    clearInterval(
      timerHandle
    );

  }


  timerHandle =
    null;


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


  startTimer();


  const elapsed =
    elapsedSeconds();


  if (
    elapsed >=
    CONFIG.EXAM_MINUTES *
    60
  ) {

    return submitExam(
      'time-expired'
    );

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

    const section =
      Math.min(
        5,
        Math.floor(
          (
            state.currentQuestion -
            1
          ) /
          20
        ) +
        1
      );


    return renderSectionIntro(
      section
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


  renderLogin();

}


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


window.addEventListener(

  'pagehide',

  () => {

    if (
      activeAudio
    ) {

      activeAudio.pause();

    }

  }

);


resume();
