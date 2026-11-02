# Testing

Use the shared CMake presets. Unit tests exercise the public native core;
Cucumber scenarios exercise the CLI and service through native steps and a
Python standard-library socket probe. Infrastructure fixtures test runner
failure propagation and cleanup separately from product coverage.

## Native checks

Linux, CMake 3.24+, Git, and GCC or Clang are required. Acceptance checks also
need Python 3, Ruby, Bundler, `patch`, and the locked gems.

```sh
bundle install
cmake --preset acceptance
cmake --build --preset acceptance
ctest --preset acceptance -L infrastructure
ctest --preset acceptance -L '^(unit|acceptance)$'
git diff --check
```

| Preset | Build directory | Selection |
| --- | --- | --- |
| `default` | `build` | Native unit tests |
| `acceptance` | `build/acceptance` | Unit, acceptance, runner regressions |
| `acceptance-only` | `build/acceptance-only` | Acceptance and regressions |
| `no-suites` | `build/no-suites` | Product suites disabled |
| `no-tests` | `build/no-tests` | Test infrastructure disabled |
| `headless` | `build/headless` | Unit tests, GUI excluded |
| `release` | `build/release` | Optimized production build, no tests |

Each has matching configure, build, and test presets. CTest intentionally
rejects a test-enabled configuration that discovers no cases. The `no-suites`,
`no-tests`, and `release` test presets explicitly permit zero discovered tests;
verify that outcome instead of introducing placeholder cases. Acceptance tests
tagged `@web` are excluded from builds with `COT_VMF_ENABLE_WEB=OFF`.

For compiler selection, sanitizer instrumentation, dependency cache paths, or
local Ruby installations, use ignored `CMakeUserPresets.json`, inherit a shared
preset, and choose a separate build directory. Keep configure/build/test
entries paired; multi-configuration generators also need matching
`configuration` values. Do not commit local presets or test artifacts.

The core tests cover exact numeric domains/scaling, text/binary encodings,
repeat/presence controls, all envelope profiles, ownership, concurrent reads,
output isolation, catalog metadata, and UDP size limits. Service scenarios
cover receive-only behavior, malformed input recovery, multiple outputs,
reloads, optimistic edits, activity, persistence, and restart recovery.
CLI scenarios cover offline imports and edits, export and validation, invalid
draft retention, runtime-only options, workspace selection, and writer locking.
Entrypoint scenarios exercise runtime overrides and one-time seeding without
requiring Docker in the native test suite.

## Browser checks

Docker Engine, Buildx, Compose v2, and Python 3 are required. Playwright is
pinned in a dedicated Docker test image; production runtime has no Node,
Chromium, or Playwright dependency.

```sh
python3 tests/browser/run.py
```

The tests exercise actual visual schema controls, full-range integer schema
import/export, pointer dragging, source/wire highlighting from UDP messages,
fanout/property editing, and draft/active persistence. Artifacts and failure
screenshots are copied to a printed temporary path. `--skip-build` reuses
already built application and browser images. Each run uses a unique Compose
project and removes its containers and volumes.
