import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntdApp, ConfigProvider } from 'antd';
import { RouterProvider } from 'react-router-dom';
import { router } from './routes';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // mock 저장소는 이 탭에서만 바뀌므로, 변경 후 직접 invalidate한다
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

export default function App() {
  return (
    <ConfigProvider theme={{ token: { borderRadius: 4 } }}>
      <AntdApp>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </AntdApp>
    </ConfigProvider>
  );
}
