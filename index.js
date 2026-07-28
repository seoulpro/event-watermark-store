import api from "./index.cjs";

export const {
  POLICY_VERSION,
  TRANSITION_STATUSES,
  EventWatermarkError,
  ProviderContractError,
  CorruptStateError,
  OperationIdConflictError,
  decideTransition,
  createEventWatermarkStore,
} = api;
