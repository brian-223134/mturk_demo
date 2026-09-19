// 5.1의 경로 표

import { Navigate, createBrowserRouter } from 'react-router-dom';
import AppLayout from './components/AppLayout';
import RouteError from './components/RouteError';
import CreatePage from './features/create/CreatePage';
import BatchDetailPage from './features/manage/BatchDetailPage';
import BatchListPage from './features/manage/BatchListPage';
import PoolListPage from './features/workers/PoolListPage';
import WorkerDetailPage from './features/workers/WorkerDetailPage';
import WorkerListPage from './features/workers/WorkerListPage';
import WorkersLayout from './features/workers/WorkersLayout';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="/manage" replace /> },
      { path: 'create', element: <CreatePage /> },
      { path: 'manage', element: <BatchListPage /> },
      { path: 'manage/:batchId', element: <Navigate to="overview" replace /> },
      { path: 'manage/:batchId/:tab', element: <BatchDetailPage /> },
      {
        path: 'workers',
        element: <WorkersLayout />,
        children: [
          { index: true, element: <WorkerListPage /> },
          { path: 'pools', element: <PoolListPage /> },
        ],
      },
      { path: 'workers/:workerId', element: <WorkerDetailPage /> },
      { path: '*', element: <RouteError notFound /> },
    ],
  },
]);
