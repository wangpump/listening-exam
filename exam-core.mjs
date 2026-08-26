export function getSectionNumber(questionNumber) {
  if (!Number.isInteger(questionNumber) || questionNumber < 1 || questionNumber > 100) {
    throw new Error('questionNumber must be an integer from 1 to 100');
  }
  return Math.ceil(questionNumber / 20);
}

export function scoreAnswers(answers, answerKey) {
  if (!Array.isArray(answerKey) || answerKey.length !== 100) {
    throw new Error('answerKey must contain exactly 100 answers');
  }
  const sections = [0, 0, 0, 0, 0];
  let total = 0;
  for (let i = 0; i < 100; i += 1) {
    const q = i + 1;
    if ((answers?.[q] || '') === answerKey[i]) {
      total += 1;
      sections[getSectionNumber(q) - 1] += 1;
    }
  }
  return { total, sections };
}

export function shouldAdvanceAfterReload(state) {
  const q = Number(state?.currentQuestion || 0);
  if (!q) return false;
  return Boolean(state?.played?.[q]) && !state?.answers?.[q];
}

export function normalizeIdentity(identity) {
  const normalized = {
    studentId: String(identity?.studentId ?? '').trim(),
    englishName: String(identity?.englishName ?? '').trim(),
    chineseName: String(identity?.chineseName ?? '').trim()
  };
  if (!normalized.studentId || !normalized.englishName || !normalized.chineseName) {
    throw new Error('学号、英文姓名和中文姓名均为必填项');
  }
  return normalized;
}

export async function playExactlyTwice(playOnce) {
  await playOnce(1);
  await playOnce(2);
}
