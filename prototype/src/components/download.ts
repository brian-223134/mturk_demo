import type { ExportFile } from '../api/types';

/** API가 돌려준 파일 내용을 브라우저의 다운로드로 넘긴다. */
export function downloadFile(file: ExportFile): void {
  // Excel이 UTF-8 CSV를 다른 인코딩으로 읽어 글자가 깨지지 않게 BOM을 붙인다 (명세 1.1의 인코딩 문제)
  const content = file.mimeType.startsWith('text/csv') ? `﻿${file.content}` : file.content;
  const url = URL.createObjectURL(new Blob([content], { type: file.mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
