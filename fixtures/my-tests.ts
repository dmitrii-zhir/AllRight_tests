import { test as base } from '@playwright/test';
import { AllRightQuizPage } from '@fixtures/all-right-quiz-page';

type MyFixtures = {
    allRightQuizPage: AllRightQuizPage;
};

export const test = base.extend<MyFixtures>({
    allRightQuizPage: async ({ page }, use): Promise<void> => {
        await use(new AllRightQuizPage(page));
    },
});
export { expect } from '@playwright/test';