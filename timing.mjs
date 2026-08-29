export const QUESTION_STARTS_MS = Object.freeze([
  15000,
  28810,
  42408,
  55952,
  69548,
  83147,
  96888,
  110434,
  124023,
  137962,
  151689,
  165282,
  178986,
  193004,
  207055,
  221073,
  235100,
  249224,
  262713,
  275841,
  303524,
  318145,
  334861,
  351764,
  368873,
  386452,
  403837,
  418969,
  435998,
  450001,
  465661,
  481594,
  497982,
  513261,
  530321,
  546071,
  562165,
  579987,
  595547,
  611115,
  639480,
  666334,
  686230,
  712333,
  734775,
  756797,
  777032,
  798524,
  818087,
  837071,
  857225,
  877277,
  897754,
  917196,
  936985,
  963641,
  984610,
  1010381,
  1031293,
  1052872,
  1089623,
  1111589,
  1131546,
  1152068,
  1174709,
  1196736,
  1218754,
  1238838,
  1259912,
  1280991,
  1305407,
  1329727,
  1350979,
  1371839,
  1392751,
  1413199,
  1432584,
  1451052,
  1471507,
  1492964,
  1528642,
  1556208,
  1581820,
  1603221,
  1631465,
  1658646,
  1688348,
  1712245,
  1739390,
  1760404,
  1782712,
  1808464,
  1828450,
  1852056,
  1873400,
  1894025,
  1914477,
  1935417,
  1956037,
  1978434
]);

// 实测同步版完整音频时长：33分25.342秒
export const EXAM_END_MS = 2005342;

export const NORMAL_GAP_MS = 2000;
export const SECTION_PREP_MS = 15000;

export function questionStartOffsetMs(questionNumber) {
  const index =
    Number(questionNumber) - 1;

  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= QUESTION_STARTS_MS.length
  ) {
    throw new Error(
      'questionNumber must be an integer from 1 to 100'
    );
  }

  return QUESTION_STARTS_MS[index];
}

export function answerLockOffsetMs(questionNumber) {
  const q =
    Number(questionNumber);

  if (
    !Number.isInteger(q) ||
    q < 1 ||
    q > 100
  ) {
    throw new Error(
      'questionNumber must be an integer from 1 to 100'
    );
  }

  if (q === 100) {
    return EXAM_END_MS;
  }

  const nextStart =
    QUESTION_STARTS_MS[q];

  return q % 20 === 0
    ? nextStart - SECTION_PREP_MS
    : nextStart - NORMAL_GAP_MS;
}

export function prepStartOffsetMs(questionNumber) {
  const q =
    Number(questionNumber);

  if (
    ![20, 40, 60, 80].includes(q)
  ) {
    throw new Error(
      'prepStartOffsetMs only applies to 20, 40, 60, 80'
    );
  }

  return (
    QUESTION_STARTS_MS[q] -
    SECTION_PREP_MS
  );
}

export function nextQuestionOffsetMs(questionNumber) {
  const q =
    Number(questionNumber);

  if (
    !Number.isInteger(q) ||
    q < 1 ||
    q >= 100
  ) {
    throw new Error(
      'questionNumber must be an integer from 1 to 99'
    );
  }

  return QUESTION_STARTS_MS[q];
}

export function timelinePosition(elapsedMs) {
  const t =
    Math.max(
      0,
      Number(elapsedMs) || 0
    );

  if (
    t <
    QUESTION_STARTS_MS[0]
  ) {
    return {
      kind: 'initial-prep',
      question: 1,
      section: 1
    };
  }

  if (
    t >=
    EXAM_END_MS
  ) {
    return {
      kind: 'finished',
      question: 101,
      section: 5
    };
  }

  // 找到当前已开始的最后一道题。
  let low = 0;
  let high =
    QUESTION_STARTS_MS.length - 1;
  let index = 0;

  while (
    low <= high
  ) {
    const mid =
      Math.floor(
        (low + high) / 2
      );

    if (
      QUESTION_STARTS_MS[mid] <= t
    ) {
      index = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const q =
    index + 1;

  const section =
    Math.ceil(q / 20);

  const lockAt =
    answerLockOffsetMs(q);

  if (
    t < lockAt
  ) {
    return {
      kind: 'question',
      question: q,
      section
    };
  }

  if (
    q < 100
  ) {
    const nextStart =
      QUESTION_STARTS_MS[
        index + 1
      ];

    if (
      t < nextStart
    ) {
      if (
        q % 20 === 0
      ) {
        return {
          kind: 'section-prep',
          question: q + 1,
          section: section + 1
        };
      }

      return {
        kind: 'gap',
        question: q,
        section
      };
    }
  }

  return {
    kind: 'question',
    question: q,
    section
  };
}
