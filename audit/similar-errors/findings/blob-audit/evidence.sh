#!/usr/bin/env bash
# Regenerates evidence.txt for the blob-audit report. Run from the repo root:
#   bash audit/similar-errors/findings/blob-audit/evidence.sh > audit/similar-errors/findings/blob-audit/evidence.txt 2>&1
set -u
cd "$(dirname "$0")/../../../.."

echo "# blob-audit evidence  ($(date -Iseconds))"
echo
echo "## 0. repo state"
echo '$ git rev-parse --short HEAD'; git rev-parse --short HEAD
echo '$ node -v'; node -v
echo
echo "## 1. probe.mjs full output"
echo '$ node --experimental-strip-types audit/similar-errors/findings/blob-audit/probe.mjs'
node --experimental-strip-types audit/similar-errors/findings/blob-audit/probe.mjs 2>&1

echo
echo "## 2. blob readers and fallback shapes (src/shared/pet-runtime/runtime-helpers.ts)"
echo '$ grep -n "export function readSharedBlob|readTaskProgress|readSignIn|readMails|readIsland|readPond|inventoryIndex|addGood|isBusy|taskCount"'
grep -n "export function readSharedBlob\|export function readTaskProgress\|export function readSignIn\|export function readMails\|export function readIsland\|export function readPond\|export function inventoryIndex\|export function addGood\|export function isBusy\|export function taskCount" src/shared/pet-runtime/runtime-helpers.ts
echo
echo '$ sed -n "231,262p;285,302p;316,354p;360,390p" src/shared/pet-runtime/runtime-helpers.ts'
sed -n '231,262p;285,302p;316,354p;360,390p' src/shared/pet-runtime/runtime-helpers.ts
echo
echo "## 3. blob schema validators: every field optional, so '{}'/'[]' pass import"
echo '$ grep -n "function assertTaskBlob|...assertPondBlob|assertFarmBlob|assertAlbumBlob|assertEmailBlob|assertActivityBlob|assertIslandCanonical|SHARED_SAVE_JSON_BLOB_VALIDATORS" src/shared/sync/data-boundary.ts'
grep -n "function assertTaskBlob\|function assertSigninBlob\|function assertPondBlob\|function assertEmailBlob\|function assertIslandCanonical\|function assertFarmBlob\|function assertAlbumBlob\|function assertActivityBlob\|SHARED_SAVE_JSON_BLOB_VALIDATORS" src/shared/sync/data-boundary.ts
echo
echo '$ sed -n "358,380p" src/shared/sync/data-boundary.ts   # assertSharedSaveData validates no non-blob group'
sed -n '358,380p' src/shared/sync/data-boundary.ts
echo
echo "## 4. non-blob canonical groups are never validated"
echo '$ grep -rn "studyInfo|selfGoodDatas|selfGoodUseOption|gameSaveDatas|illustrated|petComputedlInfo|activeOption" src/shared/sync/*.ts'
grep -rn "studyInfo\|selfGoodDatas\|selfGoodUseOption\|gameSaveDatas\|illustrated\|petComputedlInfo\|activeOption" src/shared/sync/*.ts
echo
echo "## 5. migration normalization covers petInfo.diamond only"
echo '$ sed -n "589,607p" src/shared/sync/portable.ts'
sed -n '589,607p' src/shared/sync/portable.ts
echo
echo '$ sed -n "231,254p" src/shared/sync/data-boundary.ts'
sed -n '231,254p' src/shared/sync/data-boundary.ts
echo
echo "## 6. server / local index receive the bundle without blob or group normalization"
echo '$ sed -n "147,160p" server/src/portable-import.ts'
sed -n '147,160p' server/src/portable-import.ts
echo
echo '$ sed -n "884,900p" src/main/local-repository.ts'
sed -n '884,900p' src/main/local-repository.ts
echo
echo "## 7. the local load path DOES repair every group (the missing counterpart)"
echo '$ grep -n "function repair|function startSave|const RULES" src/shared/save-logic.ts'
grep -n "function repair\|function startSave\|const RULES" src/shared/save-logic.ts
echo
echo '$ sed -n "230,262p" src/shared/save-logic.ts'
sed -n '230,262p' src/shared/save-logic.ts
echo
echo "## 8. runtime dependency points that require existing entries"
echo '$ grep -n "travel_china|studyInfo|selfGoodUseOption|illustrated|activeOption|canusecnt" ...'
grep -n "travel_china\|studyInfo\|selfGoodUseOption\|illustrated\|activeOption\|canusecnt" \
  src/shared/pet-runtime/tick.ts src/shared/pet-runtime/handlers-b.ts src/shared/pet-runtime/handlers-c.ts \
  src/shared/pet-runtime/fishing-runtime.ts src/shared/pet-runtime/travel.ts src/shared/pet-runtime/runtime-helpers.ts
echo
echo "## 9. test coverage of the audited paths"
echo '$ grep -n "static task|task.claim|unknown task" scripts/tests/pet-runtime-c3.test.mjs'
grep -n "static task\|task.claim\|unknown task" scripts/tests/pet-runtime-c3.test.mjs
echo
echo '$ grep -n "island|fishing|farm" scripts/tests/pet-runtime-c4a.test.mjs | grep "test("'
grep -n "island\|fishing\|farm" scripts/tests/pet-runtime-c4a.test.mjs | grep "test("
echo
echo '$ grep -n "task|island|farm|fish|signin|mail" server/test/server.test.ts'
grep -n "task\|island\|farm\|fish\|signin\|mail" server/test/server.test.ts \
  || echo "(no matches: server.test.ts does not exercise these command families)"
echo
echo '$ grep -n "task|daily|island" server/test/scheduler.test.ts'
grep -n "task\|daily\|island" server/test/scheduler.test.ts
echo
echo "## 10. helpers defined but never called by the runtime (fallbacks never exercised)"
echo '$ grep -rn "claimTask(|studySubjectOf(|defaultIsland(|defaultSignIn(" src --include=*.ts'
grep -rn "claimTask(\|studySubjectOf(\|defaultIsland(\|defaultSignIn(" src --include=*.ts
echo
echo "## 11. no startup/import-time materialization anywhere"
echo '$ grep -rn "ensureStaticTaskLists|resetDailyTasks|materializeIslandDay|resetFishLimits" src server/src --include=*.ts'
grep -rn "ensureStaticTaskLists\|resetDailyTasks\|materializeIslandDay\|resetFishLimits" src server/src --include=*.ts
