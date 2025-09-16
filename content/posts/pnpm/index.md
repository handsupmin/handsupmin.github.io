---
title: pnpm 설치 방식과 워크스페이스 사용법
date: "2025-09-20T16:44:51.556Z"
draft: false
tags:
  - pnpm
  - npm
  - 패키지매니저
  - 워크스페이스
categories:
  - 패키지 매니저
slug: pnpm
postId: 274b7447-6d21-8127-861e-ef8aa8769543
---

### 서문

pnpm은 npm과 유사한 CLI를 제공하면서도 의존성 저장 구조에서 차별점을 둔 패키지 매니저입니다. 대규모 모노레포나 여러 프로젝트를 동시에 관리할 때 중복 패키지로 인한 디스크 낭비를 줄이고 설치 속도를 개선하는 것이 목적입니다. 이 글은 pnpm의 설치 동작 원리와 워크스페이스 활용 방법을 실무 관점에서 정리합니다.

### 개념 및 배경

pnpm은 기본적으로 각 프로젝트의 package.json에 정의된 의존성만 설치합니다. 그러나 실제 패키지 파일은 사용자의 전용 글로벌 저장소(예: ~/.pnpm-store)에 다운로드되어 보관됩니다. 프로젝트의 node_modules에는 실제 파일 대신 글로벌 저장소의 패키지로 향하는 심볼릭 링크가 생성됩니다. 이 구조 덕분에 동일한 패키지가 여러 프로젝트에서 필요할 때 물리적 복제가 발생하지 않음.

폴더 예시는 다음과 같음

```plain text
my-project/
│
├── node_modules/        # 프로젝트 내 의존성 패키지 경로 (심볼릭 링크 포함)
│   ├── express -> ~/.pnpm-store/<hash>/node_modules/express
│   └── react -> ~/.pnpm-store/<hash>/node_modules/react
├── package.json
└── pnpm-lock.yaml
```

### 사용법 및 동작 예시

- 로컬 설치
  - 명령: pnpm install express
  - 동작: 현재 프로젝트에만 의존성 선언 및 node_modules의 심볼릭 링크 생성
- 전역 설치
  - 명령: pnpm add -g typescript
  - 동작: 시스템 전역으로 사용 가능한 바이너리/패키지 설치, 글로벌 경로는 일반적으로 ~/.local/share/pnpm (Mac/Linux 기준)
- 서브디렉터리 설치
  - 서브디렉터리에 package.json이 있으면 해당 위치에서 pnpm install을 실행하면 그 디렉터리 기준으로 설치가 이루어짐
- 워크스페이스
  - 루트에 pnpm-workspace.yaml을 두고 packages 경로를 지정하면 여러 서브패키지가 의존성을 공유하거나 직접 참조 가능
  - 예시 설정:

```yaml
packages:
  - "packages/*"
```

워크스페이스 사용 시 공통 의존성은 글로벌 저장소에 한 번만 저장되고, 각 패키지의 node_modules는 필요한 링크만 가리키도록 구성됨. 로컬 개발 시 패키지 간 참조를 쉽게 처리할 수 있어 모노레포 관리에 유리함.

### 마무리

pnpm은 프로젝트별 독립 설치 정책을 유지하면서도 글로벌 저장소와 심볼릭 링크 구조로 중복 저장을 제거해 실무에서 디스크 사용과 설치 시간을 절감함. 워크스페이스 기능을 활용하면 모노레포 환경에서 의존성 관리와 패키지 간 연동 작업이 간편해짐. 기존 npm 사용 패턴과 큰 차이 없이 도입 가능하므로, 디스크 효율이나 대규모 레포 관리가 필요할 때 우선 고려 대상임.

## 참고자료

- https://pnpm.io/
- https://pnpm.io/workspaces
