import crypto from "node:crypto";

export interface OpenCodeQuestionLiveProofEnvironment {
  acceptedTarget: string;
  baseUrl: string;
  expectedOriginSha256: string;
  expectedRevision: string;
  invocationId: string;
  paneId: string;
  tabId: string;
  token: string;
  workspaceId: string;
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value || value !== value.trim()) throw new Error(`${name} is required and must not contain surrounding whitespace`);
  return value;
};

const boundedIdentifier = (value: string, name: string): string => {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new Error(`${name} is not a bounded wmux identifier`);
  return value;
};

export const parseOpenCodeQuestionLiveProofEnvironment = (
  env: NodeJS.ProcessEnv = process.env,
): OpenCodeQuestionLiveProofEnvironment => {
  const baseUrl = required(env, "WMUX_E2E_BASE_URL").replace(/\/+$/, "");
  const parsedUrl = new URL(baseUrl);
  if (!/^https?:$/.test(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.pathname !== "/"
    || parsedUrl.search || parsedUrl.hash) {
    throw new Error("WMUX_E2E_BASE_URL must be an HTTP(S) origin without credentials, path, query, or fragment");
  }
  const acceptedTarget = required(env, "WMUX_QUESTION_PROOF_ACCEPTED_TARGET");
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(acceptedTarget)) {
    throw new Error("WMUX_QUESTION_PROOF_ACCEPTED_TARGET must be a sanitized 1-80 character label");
  }
  const expectedOriginSha256 = required(env, "WMUX_QUESTION_PROOF_ACCEPTED_ORIGIN_SHA256");
  if (!/^[0-9a-f]{64}$/.test(expectedOriginSha256)) {
    throw new Error("WMUX_QUESTION_PROOF_ACCEPTED_ORIGIN_SHA256 must be one SHA-256 digest from the accepted target decision");
  }
  const actualOriginSha256 = crypto.createHash("sha256").update(parsedUrl.origin).digest("hex");
  if (actualOriginSha256 !== expectedOriginSha256) {
    throw new Error("WMUX_E2E_BASE_URL does not match the accepted target origin digest");
  }
  const expectedRevision = required(env, "WMUX_QUESTION_PROOF_EXPECTED_REVISION");
  if (!/^[0-9a-f]{40}$/.test(expectedRevision)) {
    throw new Error("WMUX_QUESTION_PROOF_EXPECTED_REVISION must be one clean full Git revision");
  }
  const invocationId = required(env, "WMUX_QUESTION_PROOF_INVOCATION_ID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(invocationId)) {
    throw new Error("WMUX_QUESTION_PROOF_INVOCATION_ID must be a lowercase random UUIDv4");
  }
  return {
    acceptedTarget,
    baseUrl,
    expectedOriginSha256,
    expectedRevision,
    invocationId,
    paneId: boundedIdentifier(required(env, "WMUX_QUESTION_PROOF_PANE_ID"), "WMUX_QUESTION_PROOF_PANE_ID"),
    tabId: boundedIdentifier(required(env, "WMUX_QUESTION_PROOF_TAB_ID"), "WMUX_QUESTION_PROOF_TAB_ID"),
    token: required(env, "WMUX_E2E_TOKEN"),
    workspaceId: boundedIdentifier(required(env, "WMUX_QUESTION_PROOF_WORKSPACE_ID"), "WMUX_QUESTION_PROOF_WORKSPACE_ID"),
  };
};

export interface OpenCodeQuestionLiveProofArtifact {
  schemaVersion: 1;
  gate: "opencode-question-hard-server-proof";
  status: "passed";
  invocationId: string;
  target: string;
  targetOriginSha256: string;
  repositoryRevision: string;
  serverRevision: string;
  startedAt: string;
  completedAt: string;
  assertions: {
    cleanExactDeployment: true;
    realTopLevelRequest: true;
    questionShape: { singleSelect: true; multiSelect: true; custom: true };
    browserSubmission: true;
    typedSdkAcceptance: "delivered";
    sessionContinuation: true;
    finalClientState: "answered";
    finalClientResolution: "user";
    paneInput: {
      userInputMessagesAfterQuestion: 0;
      answerBytesObserved: false;
      syntheticEnterObserved: false;
      terminalResponseMessagesAfterQuestion: number;
    };
  };
  privacy: {
    rawAnswersRecorded: false;
    targetUrlRecorded: false;
    paneOrSessionIdsRecorded: false;
  };
}

export const buildOpenCodeQuestionLiveProofArtifact = (input: {
  invocationId: string;
  target: string;
  targetOriginSha256: string;
  revision: string;
  startedAt: string;
  completedAt: string;
  terminalResponseMessagesAfterQuestion: number;
}): OpenCodeQuestionLiveProofArtifact => ({
  schemaVersion: 1,
  gate: "opencode-question-hard-server-proof",
  status: "passed",
  invocationId: input.invocationId,
  target: input.target,
  targetOriginSha256: input.targetOriginSha256,
  repositoryRevision: input.revision,
  serverRevision: input.revision,
  startedAt: input.startedAt,
  completedAt: input.completedAt,
  assertions: {
    cleanExactDeployment: true,
    realTopLevelRequest: true,
    questionShape: { singleSelect: true, multiSelect: true, custom: true },
    browserSubmission: true,
    typedSdkAcceptance: "delivered",
    sessionContinuation: true,
    finalClientState: "answered",
    finalClientResolution: "user",
    paneInput: {
      userInputMessagesAfterQuestion: 0,
      answerBytesObserved: false,
      syntheticEnterObserved: false,
      terminalResponseMessagesAfterQuestion: input.terminalResponseMessagesAfterQuestion,
    },
  },
  privacy: {
    rawAnswersRecorded: false,
    targetUrlRecorded: false,
    paneOrSessionIdsRecorded: false,
  },
});

export interface ProofPaneInputObservation {
  userInputMessages: number;
  terminalResponseMessages: number;
  answerBytesObserved: boolean;
  syntheticEnterObserved: boolean;
}

export const observeProofPaneClientMessage = (
  serialized: string,
  protectedAnswerValues: string[],
): ProofPaneInputObservation => {
  const observation: ProofPaneInputObservation = {
    userInputMessages: 0,
    terminalResponseMessages: 0,
    answerBytesObserved: protectedAnswerValues.some((answer) => answer && serialized.includes(answer)),
    syntheticEnterObserved: /[\r\n]/.test(serialized),
  };
  try {
    const parsed = JSON.parse(serialized) as { type?: unknown; data?: unknown; terminalResponse?: unknown };
    if (parsed.type !== "input" || typeof parsed.data !== "string") return observation;
    const data = parsed.data;
    observation.answerBytesObserved = protectedAnswerValues.some((answer) => answer && data.includes(answer));
    observation.syntheticEnterObserved = /[\r\n]/.test(data);
    if (parsed.terminalResponse === true) observation.terminalResponseMessages = 1;
    else observation.userInputMessages = 1;
    return observation;
  } catch {
    observation.userInputMessages = 1;
    return observation;
  }
};
