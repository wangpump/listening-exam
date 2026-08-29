export function getSectionNumber(questionNumber) {
  if (
    !Number.isInteger(questionNumber) ||
    questionNumber < 1 ||
    questionNumber > 100
  ) {
    throw new Error(
      'questionNumber must be an integer from 1 to 100'
    );
  }

  return Math.ceil(questionNumber / 20);
}


export function scoreAnswers(
  answers,
  answerKey
) {
  if (
    !Array.isArray(answerKey) ||
    answerKey.length !== 100
  ) {
    throw new Error(
      'answerKey must contain exactly 100 answers'
    );
  }

  const sections = [
    0,
    0,
    0,
    0,
    0
  ];

  let total = 0;

  for (
    let i = 0;
    i < 100;
    i += 1
  ) {
    const q = i + 1;

    if (
      (answers?.[q] || '') ===
      answerKey[i]
    ) {
      total += 1;

      sections[
        getSectionNumber(q) - 1
      ] += 1;
    }
  }

  return {
    total,
    sections
  };
}


export function normalizeIdentity(
  identity
) {
  const normalized = {
    studentId:
      String(
        identity?.studentId ?? ''
      ).trim(),

    englishName:
      String(
        identity?.englishName ?? ''
      ).trim(),

    chineseName:
      String(
        identity?.chineseName ?? ''
      ).trim()
  };

  if (
    !normalized.studentId ||
    !normalized.englishName ||
    !normalized.chineseName
  ) {
    throw new Error(
      '学号、英文姓名和中文姓名均为必填项'
    );
  }

  return normalized;
}


export function jitterMs(
  maxMs,
  randomFn = Math.random
) {
  const max =
    Math.max(
      0,
      Math.floor(
        Number(maxMs) || 0
      )
    );

  if (max === 0) {
    return 0;
  }

  const r =
    Math.min(
      0.999999999,
      Math.max(
        0,
        Number(
          randomFn?.() ?? 0
        )
      )
    );

  return Math.floor(
    r * max
  );
}


export async function retryAsync(
  operation,
  options = {}
) {
  const {
    maxAttempts = 3,
    baseDelayMs = 250,
    maxDelayMs = 4000,

    sleepFn = (ms) =>
      new Promise(
        resolve =>
          setTimeout(
            resolve,
            ms
          )
      ),

    randomFn = Math.random,

    shouldRetry =
      () => true

  } = options;

  let lastError;

  const attempts =
    Math.max(
      1,
      Math.floor(
        maxAttempts
      )
    );

  for (
    let attempt = 1;
    attempt <= attempts;
    attempt += 1
  ) {
    try {
      return await operation(
        attempt
      );

    } catch (error) {
      lastError = error;

      if (
        attempt >= attempts ||
        !shouldRetry(
          error,
          attempt
        )
      ) {
        throw error;
      }

      const base =
        Math.min(
          maxDelayMs,
          baseDelayMs *
            (
              2 **
              (
                attempt - 1
              )
            )
        );

      const jitter =
        jitterMs(
          Math.max(
            1,
            Math.floor(
              base * 0.25
            )
          ),
          randomFn
        );

      await sleepFn(
        base + jitter
      );
    }
  }

  throw lastError;
}


export function createSubmissionId(
  uuidFactory,
  randomFn = Math.random
) {
  if (
    typeof uuidFactory ===
    'function'
  ) {
    const value =
      String(
        uuidFactory() || ''
      ).trim();

    if (value) {
      return value;
    }
  }

  const now =
    Date.now()
      .toString(36);

  const rand =
    Math.floor(
      (
        Number(
          randomFn?.() ??
          Math.random()
        ) || 0
      ) *
      1e12
    )
      .toString(36)
      .padStart(
        8,
        '0'
      );

  return `sub-${now}-${rand}`;
}


/*
  创建一个绝对截止时间。

  使用绝对时间而不是简单倒计时，
  可以防止学生刷新网页后重新获得时间。
*/
export function makeDeadline(
  seconds,
  nowMs = Date.now()
) {
  const safeSeconds =
    Math.max(
      0,
      Number(seconds) || 0
    );

  return (
    Number(nowMs) +
    safeSeconds * 1000
  );
}


/*
  计算距离截止时间还剩多少秒。
*/
export function remainingSeconds(
  deadlineMs,
  nowMs = Date.now()
) {
  const remainingMs =
    Math.max(
      0,
      Number(
        deadlineMs || 0
      ) -
      Number(nowMs)
    );

  return Math.ceil(
    remainingMs / 1000
  );
}
