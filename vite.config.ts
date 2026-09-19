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
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
  },
});
