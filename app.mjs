import { CONFIG } from './config.mjs';
import { QUESTIONS, SECTION_TITLES } from './questions.mjs';
import { normalizeIdentity, playExactlyTwice } from './exam-core.mjs';

const app = document.getElementById('app');
const timerBox = document.getElementById('timerBox');
const timerEl = document.getElementById('timer');
document.getElementById('examTitle').textContent = CONFIG.EXAM_TITLE;

let state = loadState();
let timerHandle = null;
let activeAudio = null;
let questionRunToken = 0;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const serverConfigured = () => /^https:\/\/script\.google\.com\/.+\/exec/.test(CONFIG.GOOGLE_APPS_SCRIPT_URL);

function freshState() {
  return {
    version: CONFIG.VERSION,
    phase: 'login',
    identity: null,
    startedAt: null,
    currentQuestion: 1,
    answers: {},
    played: {},
    submitted: false,
    submissionId: null
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
    if (!raw) return freshState();
    const parsed = JSON.parse(raw);
    if (parsed.version !== CONFIG.VERSION) return freshState();
    return { ...freshState(), ...parsed };
  } catch {
    return freshState();
  }
}

function saveState() {
  localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(state));
}

function resetState() {
  localStorage.removeItem(CONFIG.STORAGE_KEY);
  state = freshState();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function startTimer() {
  timerBox.classList.remove('hidden');
  if (timerHandle) clearInterval(timerHandle);
  const tick = async () => {
    const elapsed = Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000);
    const remaining = Math.max(0, CONFIG.EXAM_MINUTES * 60 - elapsed);
    const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
    const ss = String(remaining % 60).padStart(2, '0');
    timerEl.textContent = `${mm}:${ss}`;
    if (remaining <= 0) {
      clearInterval(timerHandle);
      timerHandle = null;
      questionRunToken += 1;
      if (activeAudio) {
        activeAudio.pause();
        activeAudio = null;
      }
      await submitExam('time-expired');
    }
  };
  tick();
  timerHandle = setInterval(tick, 1000);
}

function elapsedSeconds() {
  return Math.max(0, Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000));
}

async function postToServer(payload) {
  if (!serverConfigured()) throw new Error('Google Apps Script 尚未配置');
  const response = await fetch(CONFIG.GOOGLE_APPS_SCRIPT_URL, {
    method: 'POST',
    headers: {'Content-Type': 'text/plain;charset=utf-8'},
    body: JSON.stringify(payload),
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`提交失败：HTTP ${response.status}`);
  const data = await response.json();
  if (!data.ok) throw new Error(data.message || '服务器拒绝了请求');
  return data;
}

async function checkDuplicate(studentId) {
  if (!serverConfigured()) return false;
  const data = await postToServer({ action: 'checkAttempt', studentId });
  return Boolean(data.attempted);
}

function renderLogin(message = '') {
  timerBox.classList.add('hidden');
  app.innerHTML = `
    <div class="section-kicker">考试登录</div>
    <h2 class="section-title">${escapeHtml(CONFIG.EXAM_TITLE)}</h2>
    <p class="lead">本考试共五大题、100小题，每题1分，满分100分。每道题的录音只播放两遍；第二遍结束后只有5秒作答时间。</p>
    <div class="notice"><strong>重要：</strong>考试开始后请勿刷新、关闭页面或切换设备。某题一旦开始播放，刷新页面也不会获得重新播放机会。</div>
    ${message ? `<div class="status-error">${escapeHtml(message)}</div>` : ''}
    <form id="loginForm" class="form-grid">
      <label>学号<input id="studentId" autocomplete="off" required></label>
      <label>English Name<input id="englishName" autocomplete="off" required></label>
      <label>中文姓名<input id="chineseName" autocomplete="off" required></label>
      <button class="primary" id="startExamBtn" type="submit">确认信息并开始考试</button>
    </form>
  `;
  document.getElementById('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const btn = document.getElementById('startExamBtn');
    btn.disabled = true;
    btn.textContent = '正在确认…';
    try {
      const identity = normalizeIdentity({
        studentId: document.getElementById('studentId').value,
        englishName: document.getElementById('englishName').value,
        chineseName: document.getElementById('chineseName').value
      });
      if (await checkDuplicate(identity.studentId)) {
        throw new Error('该学号已经提交过本次考试，请联系监考老师。');
      }
      state = freshState();
      state.phase = 'section-intro';
      state.identity = identity;
      state.startedAt = new Date().toISOString();
      state.currentQuestion = 1;
      saveState();
      startTimer();
      renderSectionIntro(1);
    } catch (error) {
      renderLogin(error.message);
    }
  });
}

function renderSectionIntro(sectionNumber) {
  state.phase = 'section-intro';
  saveState();
  const start = (sectionNumber - 1) * 20 + 1;
  const end = sectionNumber * 20;
  app.innerHTML = `
    <div class="section-kicker">第 ${sectionNumber} / 5 部分</div>
    <h2 class="section-title">${escapeHtml(SECTION_TITLES[sectionNumber - 1])}</h2>
    <p class="lead">第${sectionNumber}大题共20题（第${start}—${end}题），每题1分。</p>
    <div class="notice">点击下面按钮后，本大题将自动连续进行。每题录音只播放<strong>两遍</strong>，第二遍结束后开放选项并倒计时<strong>5秒</strong>；不能暂停、重播或返回上一题。</div>
    <div class="identity-summary">
      <div><small>学号</small>${escapeHtml(state.identity.studentId)}</div>
      <div><small>English Name</small>${escapeHtml(state.identity.englishName)}</div>
      <div><small>中文姓名</small>${escapeHtml(state.identity.chineseName)}</div>
    </div>
    <div class="actions"><button id="startSection" class="primary">开始第${sectionNumber}大题</button></div>
  `;
  document.getElementById('startSection').addEventListener('click', () => {
    state.phase = 'question';
    saveState();
    startQuestion(state.currentQuestion);
  }, { once: true });
}

function renderQuestionShell(question) {
  const sectionStart = (question.section - 1) * 20 + 1;
  const withinSection = question.number - sectionStart + 1;
  const progressPct = ((question.number - 1) / QUESTIONS.length) * 100;
  app.innerHTML = `
    <div class="meta-row">
      <span>${escapeHtml(SECTION_TITLES[question.section - 1])}</span>
      <strong>${question.number} / 100</strong>
    </div>
    <div class="progress"><div style="width:${progressPct}%"></div></div>
    <div class="question-number">第 ${question.number} 题 · 本大题第 ${withinSection} / 20 题</div>
    <div class="prompt">${escapeHtml(question.prompt)}</div>
    <div class="audio-status">
      <strong id="audioStatus">准备播放</strong>
      <span id="countdown" class="countdown"></span>
    </div>
    <div id="options" class="options">
      ${['A','B','C'].map(letter => `
        <button class="option" data-answer="${letter}" disabled>
          <span class="option-letter">${letter}</span>
          <span>${escapeHtml(question.options[letter])}</span>
        </button>`).join('')}
    </div>
  `;
}

async function playAudioOnce(question, passNumber, token) {
  if (token !== questionRunToken) return;
  const status = document.getElementById('audioStatus');
  status.textContent = `第 ${passNumber} 遍播放中`;
  activeAudio = new Audio(question.audio);
  activeAudio.preload = 'auto';
  activeAudio.playsInline = true;
  await new Promise((resolve, reject) => {
    const audio = activeAudio;
    const cleanup = () => {
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
    const onEnded = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error(`第${question.number}题音频加载失败`)); };
    audio.addEventListener('ended', onEnded, { once: true });
    audio.addEventListener('error', onError, { once: true });
    audio.play().catch(onError);
  });
  activeAudio = null;
  if (passNumber === 1) await sleep(CONFIG.GAP_BETWEEN_PLAYS_MS);
}

async function startQuestion(number) {
  if (number > 100) return submitExam('completed');
  const question = QUESTIONS[number - 1];
  state.phase = 'question';
  state.currentQuestion = number;
  renderQuestionShell(question);

  if (state.played[number]) {
    // Strict anti-replay rule: a refreshed/interrupted already-started question cannot be played again.
    if (!(number in state.answers)) state.answers[number] = '';
    saveState();
    await sleep(250);
    return advanceAfterQuestion(number);
  }

  state.played[number] = true;
  saveState();
  const token = ++questionRunToken;

  try {
    await playExactlyTwice((pass) => playAudioOnce(question, pass, token));
    if (token !== questionRunToken) return;
    await openAnswerWindow(question, token);
  } catch (error) {
    app.innerHTML = `
      <div class="status-error"><strong>音频播放异常</strong><br>${escapeHtml(error.message)}。为保证考试公平，该题不会自动重播。请立即举手联系监考老师，不要刷新页面。</div>
      <p class="lead">题号：${question.number}</p>`;
  }
}

async function openAnswerWindow(question, token) {
  const status = document.getElementById('audioStatus');
  const countdown = document.getElementById('countdown');
  const buttons = [...document.querySelectorAll('.option')];
  status.textContent = '请选择答案';
  buttons.forEach(btn => {
    btn.disabled = false;
    btn.addEventListener('click', () => {
      const answer = btn.dataset.answer;
      state.answers[question.number] = answer;
      saveState();
      buttons.forEach(b => b.classList.toggle('selected', b === btn));
    });
  });

  for (let seconds = CONFIG.ANSWER_SECONDS; seconds >= 1; seconds -= 1) {
    if (token !== questionRunToken) return;
    countdown.textContent = `${seconds}s`;
    await sleep(1000);
  }
  if (!(question.number in state.answers)) state.answers[question.number] = '';
  buttons.forEach(btn => btn.disabled = true);
  status.textContent = '答案已锁定';
  countdown.textContent = '';
  saveState();
  await sleep(CONFIG.GAP_BETWEEN_QUESTIONS_MS);
  return advanceAfterQuestion(question.number);
}

async function advanceAfterQuestion(number) {
  if (number >= 100) {
    state.currentQuestion = 101;
    saveState();
    return submitExam('completed');
  }
  const next = number + 1;
  state.currentQuestion = next;
  saveState();
  const nextSection = Math.floor((next - 1) / 20) + 1;
  if ((next - 1) % 20 === 0) {
    return renderSectionIntro(nextSection);
  }
  return startQuestion(next);
}

async function submitExam(reason) {
  state.phase = 'submitting';
  saveState();
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
  timerBox.classList.remove('hidden');
  app.innerHTML = `
    <div class="section-kicker">正在交卷</div>
    <h2 class="section-title">考试已结束</h2>
    <p class="lead">正在把答卷写入成绩表，请不要关闭页面。</p>`;

  const payload = {
    action: 'submit',
    version: CONFIG.VERSION,
    reason,
    studentId: state.identity.studentId,
    englishName: state.identity.englishName,
    chineseName: state.identity.chineseName,
    startedAt: state.startedAt,
    completedAt: new Date().toISOString(),
    durationSeconds: elapsedSeconds(),
    answers: QUESTIONS.map(q => state.answers[q.number] || ''),
    userAgent: navigator.userAgent
  };

  try {
    if (serverConfigured()) {
      const result = await postToServer(payload);
      state.submitted = true;
      state.submissionId = result.submissionId || null;
      state.phase = 'finished';
      saveState();
      renderFinished();
    } else {
      state.phase = 'submission-error';
      saveState();
      renderSubmissionError('当前网页尚未配置 Google Apps Script 地址，因此只能测试考试流程，不能写入 Google Sheets。');
    }
  } catch (error) {
    state.phase = 'submission-error';
    saveState();
    renderSubmissionError(error.message);
  }
}

function renderSubmissionError(message) {
  app.innerHTML = `
    <div class="status-error"><strong>答卷尚未成功上传</strong><br>${escapeHtml(message)}</div>
    <p class="lead">你的答案仍保存在当前浏览器中。请不要重新开始考试，联系监考老师检查网络后点击“重新提交”。</p>
    <div class="actions"><button id="retrySubmit" class="primary">重新提交答卷</button></div>`;
  document.getElementById('retrySubmit').addEventListener('click', () => submitExam('retry-submit'), { once: true });
}

function renderFinished() {
  state.phase = 'finished';
  saveState();
  app.innerHTML = `
    <div class="section-kicker">SUBMITTED</div>
    <h2 class="section-title">考试结束</h2>
    <div class="status-success"><strong>你的试卷已经成功提交。</strong><br>成绩已发送到教师成绩表，请关闭本页面。</div>
    <div class="identity-summary">
      <div><small>学号</small>${escapeHtml(state.identity.studentId)}</div>
      <div><small>English Name</small>${escapeHtml(state.identity.englishName)}</div>
      <div><small>中文姓名</small>${escapeHtml(state.identity.chineseName)}</div>
    </div>`;
}

function resume() {
  if (!state.startedAt || state.phase === 'login') return renderLogin();
  if (state.submitted || state.phase === 'finished') {
    startTimer();
    return renderFinished();
  }
  startTimer();
  const elapsed = elapsedSeconds();
  if (elapsed >= CONFIG.EXAM_MINUTES * 60) return submitExam('time-expired');
  if (state.phase === 'submission-error' || state.phase === 'submitting') return submitExam('resume-submit');
  if (state.phase === 'section-intro') {
    const section = Math.min(5, Math.floor((state.currentQuestion - 1) / 20) + 1);
    return renderSectionIntro(section);
  }
  if (state.phase === 'question') return startQuestion(state.currentQuestion);
  renderLogin();
}

window.addEventListener('beforeunload', (event) => {
  if (state.startedAt && !state.submitted) {
    event.preventDefault();
    event.returnValue = '';
  }
});

resume();
