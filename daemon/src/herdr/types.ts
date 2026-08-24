export interface HerdrRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface HerdrSuccessResponse {
  id: string;
  result: Record<string, unknown>;
}

export interface HerdrErrorResponse {
  id: string;
  error: { code: string; message: string };
}

export interface HerdrEventEnvelope {
  event: string;
  data: Record<string, unknown>;
}

export type HerdrIncoming = HerdrSuccessResponse | HerdrErrorResponse | HerdrEventEnvelope;
