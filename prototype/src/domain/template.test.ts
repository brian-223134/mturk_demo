import { describe, expect, it } from 'vitest';
import { extractPlaceholders } from './template';

describe('extractPlaceholders', () => {
  it('처음 나온 순서대로, 중복 없이 뽑는다', () => {
    const html = `
      <script>
        var idx = \${idx};
        var query = \${query};
        var again = \${idx};
      </script>`;
    expect(extractPlaceholders(html)).toEqual(['idx', 'query']);
  });

  it('식별자 형태가 아닌 ${...}는 placeholder가 아니다 (JS 템플릿 리터럴의 표현식)', () => {
    const html = 'const s = `Tab ${i + 1} of ${tabs.length}`; var q = ${query};';
    expect(extractPlaceholders(html)).toEqual(['query']);
  });

  it('placeholder가 없으면 빈 배열', () => {
    expect(extractPlaceholders('<p>window.TASK_DATA를 쓰는 템플릿</p>')).toEqual([]);
  });
});
