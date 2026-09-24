// API 가 돌려준 파일 내용(ExportFile { filename, mimeType, content })을 브라우저의 다운로드로 넘긴다.

/** Excel 이 UTF-8 CSV 를 다른 인코딩으로 읽어 글자가 깨지지 않게 BOM 을 붙인다. */
export function withBom(file) {
  return file.mimeType.startsWith('text/csv') ? `﻿${file.content}` : file.content;
}

export function downloadFile(file) {
  const url = URL.createObjectURL(new Blob([withBom(file)], { type: file.mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
