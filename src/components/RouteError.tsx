import { Button, Result } from 'antd';
import { Link, useRouteError } from 'react-router-dom';

export default function RouteError({ notFound = false }: { notFound?: boolean }) {
  const error = useRouteError();
  if (notFound) {
    return (
      <Result
        status="404"
        title="Page not found"
        extra={
          <Link to="/manage">
            <Button type="primary">Back to Manage</Button>
          </Link>
        }
      />
    );
  }
  return (
    <Result
      status="error"
      title="Something went wrong"
      subTitle={error instanceof Error ? error.message : String(error)}
    />
  );
}
