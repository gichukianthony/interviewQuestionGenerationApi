export interface GenerateQuestions {
  jobTitle?: unknown;
}

export interface SuccessResponse {
  success: true;
  data: {
    jobTitle: string;
    questions: string[];
    cached?: boolean;
  };
}

export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

export interface HealthResponse {
  status: string;
  timestamp: string;
  environment: string;
}
