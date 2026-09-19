/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API 구현체 선택. 기본은 mock이고 http는 2단계(연동)에서 쓴다. */
  readonly VITE_API_MODE?: 'mock' | 'http';
  /** http 모드에서 부를 서버의 주소. 기본은 같은 origin의 /api (Vite proxy 또는 nginx가 서버로 넘긴다). */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
