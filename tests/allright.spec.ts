import { test } from '@fixtures/my-tests';

test.describe('Allright sign-up quiz', () => {
  test('completes quiz and books a trial lesson regardless of A/B variant', async ({
    allRightQuizPage
  }): Promise<void> => {
    // Живий, багатокроковий флоу (квіз + перевірка бізнес-результату через
    // API) включає десятки мережевих переходів — типовий дефолтний таймаут
    // Playwright (30с) на це не розрахований. За фактичними прогонами
    // (~48с) 2 хвилини лишають запас на повільніший день без зайвого буфера.
    test.setTimeout(120_000);

    await allRightQuizPage.goto();
    await allRightQuizPage.completeQuiz();

    // Підтвердження бізнес-результату (створений користувач + за потреби
    // заброньований пробний урок) — напряму через self-service API тієї ж
    // сесії, див. AllRightQuizPage.verifyTrialLessonBooked().
    await allRightQuizPage.verifyTrialLessonBooked();
  });
});
