#pragma once
#include "backend-wire.h"
#include "../../../packages/windows-runtime/native/process-witness.h"

namespace backend_runtime {
using windows_runtime::ProcessWitnessApi;
using windows_runtime::windowsProcessWitnessApi;
using windows_runtime::TerminationBudget;
using windows_runtime::WitnessHandle;
using windows_runtime::proveRecordedProcessExit;
}
