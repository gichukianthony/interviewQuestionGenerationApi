import express,{Request, Response, NextFunction} from "express"
import cors from "cors"
import dotenv from "dotenv"
import rateLimit from "express-rate-limit"
import morgan from "morgan"
import NodeCache from "node-cache"
import { GoogleGenerativeAI,HarmBlockThreshold,HarmCategory, SchemaType } from "@google/generative-ai"
import type { ResponseSchema } from "@google/generative-ai"
import { ErrorResponse,GenerateQuestions,HealthResponse,SuccessResponse } from "./types/types"
dotenv.config();

// loading env variables

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";

if(!GEMINI_API_KEY){
  throw new Error(
    "missing GEMINI_API_KEY in environments variables"
  );
}
const app =express();

//rate limiting
const limiter = rateLimit({
  windowMs: 15*60*1000,//15mins
  max:100,//limit ip fpr 100 requests
  message:{
    success:false,
    error:{
      code: "TOO MANY REQUESTS",
      message: "too many requests please try again later",
    }
  },
   standardHeaders:true,
   legacyHeaders:false,
})
//applying the rate limiting to the routes
app.use("/api/", limiter)

//logging
if (NODE_ENV==="production"){
  app.use(morgan("combined"));
}else{
  app.use(morgan("dev"))
}
//enabling cors
const allowedOrigins = ['https://interviewquestiongeneration.netlify.app', 'http://localhost:5173'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST'],
  maxAge: 86400       // Cache preflight requests for 24 hours
}));

//parsing the body with a limit
app.use(express.json({limit:"10kb"}));

//caching
const cache = new NodeCache({
  stdTTL: 600,//10mins
  checkperiod: 120,//check for expired key every 2mins
})

// gemini api
const genAi = new GoogleGenerativeAI(GEMINI_API_KEY)

const baseGenerationConfig = {
  temperature: 0.4,
  topP: 0.9,
  maxOutputTokens: 1024,
};

//fixed number of questions returned to the client
const QUESTION_TOTAL = 10;
//fallback parser also accepts strong interview prompts that may not end with ?
const QUESTION_STARTER_PATTERN = /^(how|what|why|when|where|who|which|can|could|would|should|do|does|did|is|are|was|were|explain|describe|walk me through|tell me about|implement|design|create|write|compare)\b/i;

const model = genAi.getGenerativeModel({
  model:"gemini-3-flash-preview",
  generationConfig: baseGenerationConfig,
   safetySettings: [
    {
      category: HarmCategory.HARM_CATEGORY_HARASSMENT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
  ],
});
//helper functions
//clean user input
function sanitizeInput(value:string):string{
  return value
  .trim()
  .replace(/\s+/g," ");
}
//validate job title
function isValidJobTitle(value:string):boolean{
  const allowedPattern = /^[a-zA-Z0-9\s&,()/+.\-]+$/;

  return (
    value.length >= 2 && value.length <= 100 && allowedPattern.test(value)
  )
}
function normalizeQuestionCandidate(value:string):string{
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\d+[\).\-\:\s]*/, "")
    .replace(/^[•\-*]\s*/, "")
    .trim();
}

//used when gemini gives us proper json and we just need to clean and dedupe it
function collectStructuredQuestions(candidates:string[]):string[]{
  const uniqueQuestions: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const cleaned = normalizeQuestionCandidate(candidate);
    const isLikelyStructuredQuestion =
      cleaned.length > 10 &&
      cleaned.length < 240 &&
      !cleaned.endsWith(":") &&
      !cleaned.startsWith("{") &&
      !cleaned.startsWith("[");
    const normalized = cleaned.toLowerCase();

    if (!cleaned || !isLikelyStructuredQuestion || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    uniqueQuestions.push(cleaned);

    if (uniqueQuestions.length >= QUESTION_TOTAL) {
      break;
    }
  }

  return uniqueQuestions;
}

//used when the model ignores the json format and returns plain text
function collectQuestions(candidates:string[]):string[]{
  const uniqueQuestions: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const cleaned = normalizeQuestionCandidate(candidate);
    const normalized = cleaned.toLowerCase();
    const isLikelyQuestion =
      cleaned.length > 10 &&
      cleaned.length < 240 &&
      (
        cleaned.endsWith("?") ||
        QUESTION_STARTER_PATTERN.test(cleaned)
      );

    if (!cleaned || !isLikelyQuestion || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    uniqueQuestions.push(cleaned);

    if (uniqueQuestions.length >= QUESTION_TOTAL) {
      break;
    }
  }

  return uniqueQuestions;
}

function stripJsonCodeFence(text:string):string{
  return text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

//first try to trust structured output because it is the most accurate path
function extractQuestionsFromJson(text:string):string[]{
  try {
    const parsed = JSON.parse(stripJsonCodeFence(text)) as unknown;

    if (Array.isArray(parsed)) {
      return collectStructuredQuestions(
        parsed.filter((item): item is string => typeof item === "string")
      );
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      "questions" in parsed &&
      Array.isArray((parsed as { questions?: unknown }).questions)
    ) {
      const questions = (parsed as { questions: unknown[] }).questions.filter(
        (item): item is string => typeof item === "string"
      );

      return collectStructuredQuestions(questions);
    }
  } catch {
    return [];
  }

  return [];
}

//extract question from ai
function extractQuestion(text:string):string[]{
  //split noisy plain text into lines so we can recover question-like entries
  const normalizedText = text.replace(/\r\n/g, "\n").trim();
  const lines = normalizedText
    .replace(/([?!.])\s+(?=\d+[\).\:-]\s+)/g, "$1\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const questionCandidates = lines.filter((line) => line.includes("?"));

  return collectQuestions(questionCandidates);
}
// Generate Ai prompt
function generatePrompt(jobTitle:string):string{
   return `
You are an experienced hiring manager and interview coach.

Generate exactly ${QUESTION_TOTAL} interview questions for the following role:

"${jobTitle}"

Requirements:
- Questions must be specific to the role
- Questions should assess practical skills and experience
- Keep questions professional and realistic
- Avoid generic or repetitive questions
- Each question must be concise
- Return ONLY a JSON array of strings
- Include exactly ${QUESTION_TOTAL} questions
- Each item must contain one full interview question
- Do not include section headings such as "Advanced Coding Questions" or "System Design"
- Do not include explanations, examples, code snippets, or extra categories
- Do not include introductions, explanations, markdown, or code fences
`;
}

function buildQuestionSchema():ResponseSchema {
  return {
    type: SchemaType.ARRAY,
    minItems: QUESTION_TOTAL,
    maxItems: QUESTION_TOTAL,
    items: {
      type: SchemaType.STRING,
      description: "A concise interview question tailored to the requested role",
    },
  };
}

async function generateQuestionsWithRetry(
  jobTitle:string,
  retries:number = 3
):Promise<{questions:string[]; rawResponse:string}> {
  let lastError:Error | null = null;
  let lastResponse = "";

  //retry helps with temporary model formatting issues and short responses
  for (let i = 0; i < retries; i++) {
    try {
      const prompt = generatePrompt(jobTitle);
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          ...baseGenerationConfig,
          responseMimeType: "application/json",
          responseSchema: buildQuestionSchema(),
        },
      });
      const aiText = result.response.text();
      lastResponse = aiText;

      //prefer clean json before falling back to text scraping
      const jsonQuestions = extractQuestionsFromJson(aiText);
      if (jsonQuestions.length >= QUESTION_TOTAL) {
        return {
          questions: jsonQuestions.slice(0, QUESTION_TOTAL),
          rawResponse: aiText,
        };
      }

      const fallbackQuestions = extractQuestion(aiText);
      if (fallbackQuestions.length >= QUESTION_TOTAL) {
        return {
          questions: fallbackQuestions.slice(0, QUESTION_TOTAL),
          rawResponse: aiText,
        };
      }

      lastError = new Error(`AI did not return ${QUESTION_TOTAL} valid interview questions`);
    } catch (error) {
      lastError = error as Error;
    }

    if (i < retries - 1) {
      const delay = 1000 * Math.pow(2, i);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw Object.assign(
    lastError || new Error("failed to generate content after retries"),
    { rawResponse: lastResponse }
  );
}
//enpoints
//api helathy
app.get("/health", (req:Request, res:Response<HealthResponse>)=>{
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    environment:NODE_ENV
  })
})
//QUESTION GENERATION
app.post("/api/questions",async(req:Request<{},SuccessResponse,GenerateQuestions>,
   res:Response<SuccessResponse | ErrorResponse>, next:NextFunction)=>{
    try{
      const {jobTitle} =req.body;
      if(jobTitle ===undefined){
        return res.status(400).json({
          success:false,
          error:{
            code: "missing job title",
            message: "job title is required"
          }
        })
      }
      //type validation
      if(typeof jobTitle !== "string"){
        return res.status(400).json({
          success:false,
          error:{
            code: "invalid type",
            message: "job title must be a string"
          }
        })
      }
      const sanitizedJobTitle = sanitizeInput(jobTitle);
      //validate content

      if(!isValidJobTitle(sanitizedJobTitle)){
        return res.status(400).json({
          success:false,
          error:{
            code: "invalid job title",
            message: "please provide a valid professional job title(2-100 character)"
          }
        })
      }
      //caching
      const cacheKey =`questions:${sanitizedJobTitle.toLowerCase()}`;
      const cachedResponse   = cache.get<SuccessResponse["data"]>(cacheKey);
        if (cachedResponse) {
        return res.status(200).json({
          success: true,
          data: {
            ...cachedResponse,
            cached: true,
          },
        });
      }
      //call gemini only when we do not already have a cached answer
       const { questions } = await generateQuestionsWithRetry(sanitizedJobTitle);
       if (questions.length < QUESTION_TOTAL) {
        return res.status(502).json({
          success: false,
          error: {
            code: "Bad ai response ",
            message: `AI did not return ${QUESTION_TOTAL} valid interview questions`,
          },
        });
      }
      //response preparation
      const responseData = {
        jobTitle: sanitizedJobTitle,
        questions,
      };
       cache.set(cacheKey, responseData);
       return res.status(200).json({
        success: true,
        data: responseData,
      });
    } catch (error) {
      next(error);
    }
  }
);
//404 error handling
app.use((_req: Request, res: Response<ErrorResponse>) => {
  return res.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: "Route not found",
    },
  });
});
//handle errors globally 
app.use((error: unknown,req: Request,res: Response<ErrorResponse>,next: NextFunction) => {
    // Log full error for debugging
    console.error("Unhandled Error:", error);
    // Check for specific error types
    if (error && typeof error === "object" && "code" in error) {
      const err = error as { code?: string; message?: string };  
      // Rate limit errors
      if (err.code === "TOO_MANY_REQUESTS") {
        return res.status(429).json({
          success: false,
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: err.message || "Too many requests",
          },
        });
      }
      
      // Gemini API specific errors
      if (err.code === "429") {
        return res.status(429).json({
          success: false,
          error: {
            code: "AI_SERVICE_BUSY",
            message: "AI service is busy, please try again later",
          },
        });
      }
    }

    // Generic error response
    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: NODE_ENV === "production" 
          ? "Something went wrong on the server"
          : error instanceof Error ? error.message : "Unknown error occurred",
      },
    });
  }
);
app.listen(PORT,()=>{
  console.log( `app is running on port ${PORT}`)
})
