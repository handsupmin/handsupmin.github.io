---
title: pnpm 설치 방식과 프로젝트별 의존성 관리
date: '2025-09-20T16:25:57.441Z'
draft: false
tags:
  - pnpm
  - 패키지매니저
  - Node.js
  - 워크스페이스
categories:
  - Node.js 패키지 관리자
slug: pnpm
postId: 274b7447-6d21-8127-861e-ef8aa8769543
---
핵심 요약. pnpm은 프로젝트 별 node_modules에는 심볼릭 링크만 두고, 실제 패키지는 전역 전용 저장소에 보관하는 방식으로 중복 설치를 막음. 이 구조로 의존성 설치 속도 및 디스크 사용 효율 개선.

설치 방식 개요. pnpm 실행 시 해당 프로젝트 디렉터리에만 의존성 링크를 생성함. 실제 패키지 파일은 pnpm 전용 저장소(기본 경로: ~/.pnpm-store 또는 글로벌 설치 시 ~/.local/share/pnpm)에 다운로드 및 저장됨. 프로젝트의 node_modules에는 글로벌 저장소에 있는 패키지로 향하는 심볼릭 링크 생성.

폴더 구조 예시. 구조 이해를 위해 예시 표기.

```plain text
my-project/
│
├── node_modules/        # 프로젝트 내 의존성 패스(심볼릭 링크 포함)
│   ├── express -> ~/.pnpm-store/<hash>/node_modules/express
│   └── react -> ~/.pnpm-store/<hash>/node_modules/react
├── package.json
└── pnpm-lock.yaml
```

설치 범위. `pnpm install`은 실행한 디렉터리의 package.json에 정의된 의존성만 처리함. 각 프로젝트는 자신만의 node_modules(링크) 집합을 가지므로 다른 프로젝트와 의존성이 격리됨. 서브디렉터리에 별도의 package.json이 있으면 해당 위치에서 `pnpm install`을 실행해 로컬에만 설치 가능.

전역 설치 vs 로컬 설치. 로컬 설치(기본):

```bash
pnpm install express
```

- 현재 프로젝트에 링크 생성. 글로벌 저장소에 실제 파일 존재.

전역 설치(시스템 범위):

```bash
pnpm add -g typescript
```

- 전역 명령으로 사용하려는 패키지 설치. 글로벌 저장 경로는 플랫폼에 따라 기본 경로 사용.

워크스페이스 활용. 대형 프로젝트나 모노레포에서는 pnpm-workspace.yaml로 패키지들을 선언해 의존성 공유 가능. 예:

```yaml
packages:
  - 'packages/*'
```

- 워크스페이스 루트에서 의존성을 설치하면 서브패키지들이 효율적으로 의존성을 참조 및 공유함. 글로벌 저장소와 링크 방식을 그대로 활용해 중복 최소화.

운영상 유의점. 심볼릭 링크를 사용하는 구조 때문에 일부 도구나 환경에서 링크 처리 방식에 영향이 있을 수 있음. CI 환경에서는 캐시 디렉터리 설정, 권한, 플랫폼별 경로 차이 확인 권장.

결론. pnpm은 실제 파일을 전역 저장소에 한 번만 보관하고, 각 프로젝트에는 링크만 두는 방식으로 디스크 절약과 빠른 설치를 달성함. 워크스페이스와 조합하면 모노레포 운영에 유리함.

## 간단 요약
- 프로젝트 디렉터리에만 의존성 링크 생성, 실제 패키지는 전역 저장소 보관
- 중복 설치 방지로 디스크 절약 및 설치 속도 개선
- 서브디렉터리 별 설치는 독립적 실행으로 처리
- 워크스페이스로 여러 패키지 간 의존성 공유 및 효율화

## 참고자료
- https://pnpm.io/
- https://pnpm.io/installation
- https://pnpm.io/workspaces
