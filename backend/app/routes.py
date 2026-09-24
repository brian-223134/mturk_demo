"""REST 경로 표. prototype/src/api/http/routes.ts 의 API_ROUTES 를 키 하나하나(이름, 메서드, 경로, 인자) 그대로 옮긴 것이다.

두 표가 어긋나지 않도록 테스트가 routes.ts 를 읽어 이 표와 대조한다 (backend/tests, 다음 단계). MOCK_ROUTES(/mock/*)는
mock 환경 전용이라 만들지 않는다.

인자를 요청에 싣는 규칙 (routes.ts 와 같다)
  - 경로의 `:이름` 과 같은 이름의 인자는 경로에 넣는다.
  - GET, DELETE 의 나머지 인자는 query string 에 넣는다. `q`(ListQuery)는 page, pageSize, sort=필드:방향, filters=JSON 으로 편다.
  - POST, PUT 의 나머지 인자는 JSON body 에 이름으로 넣는다. 인자 이름이 `body` 면 그 값 자체가 body 다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

API_PREFIX = "/api"
PARAM_RE = re.compile(r":([A-Za-z]+)")


@dataclass(frozen=True)
class RouteDef:
    method: str            # GET | POST | PUT | DELETE
    path: str              # API_PREFIX 를 뺀 경로. 경로 인자는 :이름
    args: tuple[str, ...]  # 메서드의 인자 이름 (순서대로)


API_ROUTES: dict[str, RouteDef] = {
    "listTemplates": RouteDef("GET", "/templates", ()),
    "getTemplate": RouteDef("GET", "/templates/:id", ("id",)),
    "saveTemplate": RouteDef("POST", "/templates", ("body",)),
    "deleteTemplate": RouteDef("DELETE", "/templates/:id", ("id",)),

    "listBatches": RouteDef("GET", "/batches", ()),
    "getBatch": RouteDef("GET", "/batches/:id", ("id",)),
    "createBatch": RouteDef("POST", "/batches", ("body",)),
    "expireBatch": RouteDef("POST", "/batches/:id/expire", ("id",)),

    "listHits": RouteDef("GET", "/batches/:batchId/hits", ("batchId", "q")),
    "getHit": RouteDef("GET", "/hits/:hitId", ("hitId",)),
    "listAssignments": RouteDef("GET", "/batches/:batchId/assignments", ("batchId", "q")),
    "approveAssignments": RouteDef("POST", "/assignments/approve", ("ids", "feedback", "override")),
    "rejectAssignments": RouteDef("POST", "/assignments/reject", ("ids", "feedback")),
    "addAssignments": RouteDef("POST", "/hits/add-assignments", ("hitIds", "mode")),

    "getResults": RouteDef("GET", "/batches/:batchId/results", ("batchId",)),
    "exportBatch": RouteDef("GET", "/batches/:batchId/export", ("batchId", "format")),

    "listWorkers": RouteDef("GET", "/workers", ("q",)),
    "getWorker": RouteDef("GET", "/workers/:id", ("id",)),
    "updateWorkerNote": RouteDef("PUT", "/workers/:id/note", ("id", "note")),

    "listPools": RouteDef("GET", "/pools", ()),
    "createPool": RouteDef("POST", "/pools", ("body",)),
    "addWorkersToPool": RouteDef("POST", "/pools/:poolId/workers", ("poolId", "workerIds")),
    "removeWorkersFromPool": RouteDef("POST", "/pools/:poolId/workers/remove", ("poolId", "workerIds")),
    "blockWorkers": RouteDef("POST", "/workers/block", ("ids", "reason")),
    "unblockWorkers": RouteDef("POST", "/workers/unblock", ("ids",)),

    "getAccount": RouteDef("GET", "/account", ()),
}


def path_param_names(path: str) -> list[str]:
    return PARAM_RE.findall(path)


def fastapi_path(path: str) -> str:
    """routes.ts 의 `/batches/:id` → FastAPI 의 `/batches/{id}`."""
    return PARAM_RE.sub(r"{\1}", path)
