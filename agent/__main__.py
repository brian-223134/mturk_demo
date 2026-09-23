"""python3 -m agent 진입점. 종료 코드는 cli.main이 돌려준다."""

import sys

from agent.cli import main

if __name__ == "__main__":
    sys.exit(main())
