// Review 의 대조 기준 컬럼의 셀을 읽는 부분. prototype/src/domain/reference.ts 에서 Settings 화면이 쓰는 parseReferenceCell 만 옮겼다.
// (문항에 대응시키는 mapReferenceToAnswers 등은 서버가 한다.)

const PYTHON_WORDS = { True: 'true', False: 'false', None: 'null' };
const PYTHON_ESCAPES = { n: '\n', t: '\t', r: '\r', "'": "'", '"': '"', '\\': '\\' };

/**
 * Python repr(작은따옴표 문자열, True/False/None)을 JSON 텍스트로 바꾼다. 문자열 안은 이스케이프를 풀어
 * JSON 문자열로 다시 쓰고, 밖은 True/False/None 만 바꾼다. 닫히지 않은 문자열이면 undefined.
 */
function pythonToJson(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "'") {
      const next = text.indexOf("'", i);
      const end = next < 0 ? text.length : next;
      out += text.slice(i, end).replace(/\b(True|False|None)\b/g, (word) => PYTHON_WORDS[word]);
      i = end;
      continue;
    }
    let inner = '';
    i += 1;
    while (i < text.length && text[i] !== "'") {
      if (text[i] !== '\\') {
        inner += text[i];
        i += 1;
        continue;
      }
      const code = text[i + 1] ?? '';
      if (code === 'x' || code === 'u') {
        const hex = text.slice(i + 2, i + (code === 'x' ? 4 : 6));
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== (code === 'x' ? 2 : 4)) return undefined;
        inner += String.fromCharCode(Number.parseInt(hex, 16));
        i += 2 + hex.length;
      } else {
        inner += PYTHON_ESCAPES[code] ?? code;
        i += 2;
      }
    }
    if (i >= text.length) return undefined;
    i += 1;
    out += JSON.stringify(inner);
  }
  return out;
}

/**
 * 셀 문자열을 값으로. JSON → 실패하면 Python 리터럴을 JSON 으로 바꿔 다시 시도 → 그래도 안 되면 셀 전체를 값 하나로 본다
 * (문항이 하나인 과제의 GT 컬럼은 `grounded` 처럼 평문이다). 빈 셀은 undefined.
 * Python 변환은 셀에 큰따옴표가 없을 때만 한다 (repr 은 작은따옴표가 든 문자열을 큰따옴표로 감싼다). eval 은 쓰지 않는다.
 */
export function parseReferenceCell(cell) {
  const text = String(cell ?? '').trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // Python 리터럴로 다시 시도한다
  }
  if (text.includes('"')) return text;
  const json = pythonToJson(text);
  if (json === undefined) return text;
  try {
    return JSON.parse(json);
  } catch {
    return text;
  }
}
