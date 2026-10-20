import type { GameSessionState } from '../pet-runtime/types'
import type { ExamQuestionProjection, ResultDataMap } from './protocol'

function requireKind<K extends GameSessionState['payload']['kind']>(
  session: Pick<GameSessionState, 'sessionToken' | 'payload'>,
  kind: K,
): Extract<GameSessionState['payload'], { kind: K }> {
  if (session.payload.kind !== kind) throw new Error('session kind mismatch: expected ' + kind)
  return session.payload as Extract<GameSessionState['payload'], { kind: K }>
}

/** Public exam projection: never carries answerIndex/answer keys. */
export function projectExamSession(session: Pick<GameSessionState, 'sessionToken' | 'payload'>): ResultDataMap['exam.start'] {
  const payload = requireKind(session, 'exam')
  const questions: ExamQuestionProjection[] = payload.questions.map(question => ({
    questionId: question.questionId,
    prompt: question.prompt,
    options: [...question.options],
  }))
  return { sessionToken: session.sessionToken, questions }
}

/** Public island quiz projection: answerIndex stays in canonical engine state only. */
export function projectIslandQuizSession(
  session: Pick<GameSessionState, 'sessionToken' | 'payload'>,
): ResultDataMap['island.startQuiz'] {
  const payload = requireKind(session, 'island_quiz')
  return {
    sessionToken: session.sessionToken,
    recordId: payload.recordId,
    quizKind: payload.quizKind,
    prompt: payload.prompt,
    options: [...payload.options],
  }
}
