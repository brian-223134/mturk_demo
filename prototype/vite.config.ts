import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Docker의 bind mount로는 파일 변경 이벤트가 컨테이너에 전달되지 않는 환경이 있다 (일부 Windows/WSL2 구성 등).
// 그때는 VITE_WATCH_POLLING=true로 dev 서버를 띄워 주기적으로 파일을 확인하게 한다. 기본은 이벤트 방식이다.
const usePolling = process.env.VITE_WATCH_POLLING === 'true';

export default defineConfig({
  plugins: [react()],
  server: {
    watch: usePolling ? { usePolling: true, interval: 300 } : undefined,
    // http 모드(VITE_API_MODE=http)에서 브라우저는 같은 origin의 /api를 부르고, dev 서버가 mock API 서버로 넘긴다
    proxy: { '/api': process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8787' },
    // Vite의 root는 이 폴더(prototype/)지만, mock 모드의 시작 데이터 data/와 "Load sample"이 쓰는 example/은 저장소 루트에 있다.
    // dev 서버는 root 밖의 파일을 기본으로 거부하므로 저장소 루트 전체를 허용한다.
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
  },
});
