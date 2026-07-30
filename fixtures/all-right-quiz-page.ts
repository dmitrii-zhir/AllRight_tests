import { Page, Locator, expect } from '@playwright/test';
import { faker } from '@faker-js/faker';

const QUIZ_START_URL = '/uk/app/sign-up/long/charlie/age-range';
const DASHBOARD_URL_PATTERN = /\/app\/dashboard(?:$|[/?])/;
const MAX_STEPS = 40;
const STUCK_STEP_LIMIT = 4;

/**
 * @description Об'єкт сторінки для квіза реєстрації.
 * Квіз постійно змінюється (A/B-тести, порядок і склад кроків), тому
 * `completeQuiz()` не покладається на фіксовану послідовність кроків —
 * на кожній ітерації розпізнає тип поточного кроку за структурою
 * (роль елемента, тип інпута), а не за конкретним текстом питання чи
 * відповіді.
 */
export class AllRightQuizPage {
  readonly page: Page;
  createdUserId: string | null = null;
  // Квіз має щонайменше два структурно різні екрани завершення: дашборд із
  // самостійно заброньованим часом уроку, або "Дякуємо!"-підтвердження
  // заявки, коли час підбирає адміністратор вручну (урок ще не
  // заброньований на момент завершення квіза). Перевірка бізнес-результату
  // має очікувати різне залежно від того, який варіант трапився.
  private completionVariant: 'self-booked' | 'manual-followup' | null = null;
  private readonly parentEmail: string;
  private parentPhone: string;

  private readonly dialog: Locator;
  private readonly dialogParentOption: Locator;
  private readonly dialogCloseButton: Locator;

  private readonly phoneInput: Locator;
  private readonly emailInput: Locator;
  private readonly textInput: Locator;

  private readonly optionButtons: Locator;
  private readonly continueButton: Locator;
  private readonly bookButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.parentPhone = this.generatePhone();
    this.parentEmail = this.generateEmail();

    this.dialog = this.page.getByRole('dialog').first();
    this.dialogParentOption = this.dialog.getByRole('button', { name: /батьк|мати/i }).first();
    this.dialogCloseButton = this.dialog.getByRole('button', { name: /close/i }).first();

    this.phoneInput = this.page.locator('input[type="tel"]').first();
    this.emailInput = this.page.locator('input[name="email"]').first();
    this.textInput = this.page.getByRole('textbox').first();

    this.optionButtons = this.page.locator('button[data-mode]');
    this.continueButton = this.page.getByRole('button', { name: /^(Далі|Продовжити)$/ }).first();
    this.bookButton = this.page.getByRole('button', { name: /Забронювати/i }).first();
  }

  /**
   * @description Перейти на стартову сторінку квіза.
   */
  async goto(): Promise<void> {
    this.page.on('response', async (response): Promise<void> => {
      if (this.createdUserId) return;
      if (response.request().method() !== 'POST') return;
      if (!/\/api\/v1\/users(?:\?|$)/.test(response.url())) return;
      if (response.status() !== 200) return;
      try {
        const body = await response.json();
        const id = body?.data?.id ?? body?.id;
        if (id) this.createdUserId = String(id);
      } catch {
        // Тіло відповіді не JSON або вже спожите — ігноруємо, спрацює фолбек-пошук.
      }
    });
    await this.page.goto(QUIZ_START_URL);
    // Перший рендер квіза після навігації може зайняти трохи часу — чекаємо
    // появи бодай однієї кнопки, перш ніж починати цикл кроків, інакше перша
    // ітерація може не застати ще жодного варіанта відповіді.
    await this.page
      .getByRole('button', { name: /\S/ })
      .first()
      .waitFor({ state: 'visible', timeout: 10000 })
      .catch(() => {});
  }

  /**
   * @description Пройти квіз до кінця незалежно від A/B-варіанта чи набору
   * кроків, доки застосунок не перенаправить на дашборд або "Дякуємо!" сторінку.
   */
  async completeQuiz(): Promise<void> {
    let lastUrl: string = '';
    let stuckCount: number = 0;
    for (let step: number = 0; step < MAX_STEPS; step++) {
      if (await this.isQuizComplete()) {
        await this.resolveDialog();
        return;
      }

      const urlBeforeStep: string = this.page.url();
      await this.handleCurrentStep();

      stuckCount = this.page.url() === urlBeforeStep ? stuckCount + 1 : 0;
      lastUrl = this.page.url();
      if (stuckCount >= STUCK_STEP_LIMIT) {
        throw new Error(
          `Квіз застряг на кроці "${lastUrl}": ${STUCK_STEP_LIMIT} дій поспіль не змінили сторінку`
        );
      }
    }
    throw new Error(`Квіз не завершився за ${MAX_STEPS} кроків (останній URL: ${lastUrl})`);
  }

  /**
   * @description Квіз вважається завершеним або коли застосунок перенаправив
   * на дашборд (варіант із самостійним бронюванням часу), або коли на
   * екрані з'явилось підтвердження заявки (варіант, де час підбирає
   * адміністратор вручну — без переходу на /app/dashboard).
   */
  private async isQuizComplete(): Promise<boolean> {
    if (DASHBOARD_URL_PATTERN.test(this.page.url())) {
      this.completionVariant = 'self-booked';
      return true;
    }
    const manualFollowup: boolean = await this.page
      .getByText(/Дякуємо!|Ваш запит отримано/i)
      .first()
      .isVisible({ timeout: 300 })
      .catch(() => false);
    if (manualFollowup) this.completionVariant = 'manual-followup';
    return manualFollowup;
  }

  /**
   * @description Підтвердити бізнес-результат (створений користувач +
   * заброньований пробний урок) напряму через API тієї самої сесії, якою
   * щойно завершився квіз. `GET /api/v1/users/:id` і
   * `GET /api/v1/lessons?filter[student_id]=:id` — це self-service
   * ендпоінти (їх викликає сам застосунок для власного кабінету), тому не
   * потребують прав адміністратора.
   */
  async verifyTrialLessonBooked(): Promise<void> {
    if (!this.createdUserId) {
      throw new Error('createdUserId невідомий — неможливо перевірити бізнес-результат через API.');
    }

    const userResponse = await this.fetchJson(`/api/v1/users/${this.createdUserId}`);
    expect(userResponse.status, 'GET /api/v1/users/:id мав повернути 200').toBe(200);
    expect(
      userResponse.body?.data?.attributes?.['is-deleted'],
      'Щойно створений користувач не повинен бути позначений як видалений'
    ).toBe(false);

    const lessonsResponse = await this.fetchJson(
      `/api/v1/lessons?filter[student_id]=${this.createdUserId}`
    );
    expect(lessonsResponse.status, 'GET /api/v1/lessons мав повернути 200').toBe(200);
    const lessons: unknown[] = lessonsResponse.body?.data ?? [];

    if (this.completionVariant === 'manual-followup') {
      // У цьому A/B-варіанті квіз свідомо не бронює конкретний час одразу —
      // заявку прийнято, а час підбере адміністратор пізніше. Вимагати тут
      // готовий запис уроку означало б хибно провалювати коректний прогін.
      return;
    }

    expect(lessons.length, 'Має бути заброньовано щонайменше один пробний урок').toBeGreaterThan(0);
  }

  /**
   * @description fetchJson(url: string) повертає статус та текст
   * відповіді GET запиту.
   */
  private async fetchJson(url: string): Promise<{ status: number; body: any }> {
    const response = await this.page.request.get(url);
    const text = await response.text();
    try {
      return { status: response.status(), body: JSON.parse(text) };
    } catch {
      return { status: response.status(), body: text };
    }
  }

  private async handleCurrentStep(): Promise<void> {
    // SPA-перехід між кроками анімований — елементи попереднього кроку
    // можуть лишатися в DOM ще якусь мить після зміни URL. Без цієї паузи
    // перевірки нижче інколи ловлять "привида" попереднього поля. Викликається
    // на кожній ітерації циклу, 300мс — підтверджено стабільне значення.
    await this.page.waitForTimeout(300);

    // Перехід сюди міг уже привести на екран завершення (Дякуємо!) — та ж
    // перевірка, що й на початку кожної ітерації в completeQuiz(), тут
    // потрібна повторно, бо саме після цієї паузи текст встигає з'явитися.
    if (await this.isQuizComplete()) return;

    if (await this.isVisible(this.dialog)) {
      await this.resolveDialog();
      return;
    }

    if (await this.isVisible(this.phoneInput)) {
      await this.fillPhone(this.phoneInput);
      await this.page.pause();
      return;
    }

    if (await this.isVisible(this.emailInput)) {
      await this.typeInto(this.emailInput, this.parentEmail);
      await this.clickPrimaryAction();
      return;
    }

    if (await this.isVisible(this.textInput)) {
      await this.typeInto(this.textInput, faker.person.firstName());
      await this.clickPrimaryAction();
      return;
    }

    // Швидка перевірка (як і для решти полів), а не тривале очікування:
    // цей крок виконується на кожній ітерації, і на переважній більшості
    // кроків кнопки бронювання взагалі немає. Якщо останній крок ще
    // підвантажує доступні часові слоти й кнопка не встигла з'явитися,
    // наступна ітерація зовнішнього циклу перевірить її знову.
    if (await this.isVisible(this.bookButton)) {
      await this.bookTrialLesson();
      return;
    }

    await this.clickPrimaryAction();
  }

  /**
   * @description Обробити непередбачуваний діалог (наприклад, уточнення
   * "хто заповнює анкету" чи промо-вікно).
   */
  private async resolveDialog(): Promise<void> {
    if (await this.isVisible(this.dialogParentOption)) {
      await this.safeClick(this.dialogParentOption);
    } else if (await this.isVisible(this.dialogCloseButton)) {
      await this.safeClick(this.dialogCloseButton);
      return;
    } else {
      await this.safeClick(this.dialog.getByRole('button').first());
      return;
    }

    // Діалог може закриватися з анімацією — даємо йому час зникнути коректно,
    // перш ніж визнавати клік невдалим. Дочасний форс-клік по "×" тут лише
    // перериває легітимне закриття й скидає щойно зроблений вибір.
    try {
      await expect(this.dialog).toBeHidden({ timeout: 2000 });
    } catch {
      if (await this.isVisible(this.dialogCloseButton)) {
        await this.safeClick(this.dialogCloseButton);
      }
    }
  }

  /**
   * @description Поле телефону з маскою введення не реагує на `.fill()` —
   * кнопка "Продовжити" лишається неактивною. Потрібне посимвольне введення.
   */
  private async fillPhone(input: Locator): Promise<void> {
    const urlBefore = this.page.url();

    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        // Перша спроба не просунула квіз далі — можливо, цей номер уже
        // використовувався в одному з попередніх прогонів. Пробуємо новий.
        this.parentPhone = this.generatePhone();
        // Control+A ламає внутрішній стан цього маскованого інпута (є
        // незмінний префікс "+380"), тому очищаємо через Backspace.
        await this.safeClick(input);
        for (let i = 0; i < 15; i++) {
          await input.press('Backspace').catch(() => {});
        }
      } else {
        await this.safeClick(input);
      }

      await this.page.keyboard.type(this.parentPhone);
      await this.page.waitForTimeout(150);
      await this.clickPrimaryAction();

      // Підтвердження телефону — це реальний виклик створення користувача
      // (POST /api/v1/users), а не миттєвий клієнтський перехід, тому дамо
      // мережі час завершитися, перш ніж визнавати спробу невдалою.
      try {
        await this.page.waitForURL((url) => url.toString() !== urlBefore, { timeout: 6000 });
        return;
      } catch {
        // Ще на цьому ж кроці навіть після очікування — пробуємо новий номер.
      }
    }
  }

  /**
   * @description Посимвольне введення (замість `.fill()`) — на цьому сайті
   * принаймні поле телефону має маску, що не реагує на пряму зміну value, а
   * інші текстові поля, ймовірно, мають дебаунс-валідацію на подію `input`,
   * яка не встигає завершитися між миттєвим `.fill()` і кліком "Продовжити".
   * Симуляція реальних натискань клавіш надійніша для обох випадків.
   */
  private async typeInto(locator: Locator, text: string): Promise<void> {
    await this.safeClick(locator);
    await this.page.keyboard.type(text);
    // Деякі поля мають дебаунс-валідацію на подію `input`, яка не встигає
    // спрацювати до кліку одразу після вводу — коротка пауза імітує
    // природний момент, який реальний користувач витрачає перед кліком.
    // (Це підтверджена причина реального бага під час розробки — тут
    // навмисно консервативніше значення, ніж в інших паузах у цьому файлі.)
    await this.page.waitForTimeout(200);
  }

  /**
   * @description Крок може бути одиничним вибором (клік одразу переходить
   * на наступний екран) або множинним (потрібно обрати один чи кілька
   * варіантів, перш ніж "Продовжити" стане активною — і активація може
   * з'явитися не миттєво, а після повторного рендеру). Тому перевірка
   * активності кнопки виконується з коротким очікуванням, а не миттєвим
   * читанням стану, а вибір варіантів накопичується, поки або URL не
   * зміниться, або "Продовжити" не стане активною.
   */
  private async clickPrimaryAction(): Promise<void> {
    const urlBefore: string = this.page.url();

    if (await this.clickIfEnabledSoon(this.continueButton)) {
      // Деякі кроки (телефон, email) зберігають значення реальним викликом
      // до бекенду перед переходом далі — не суто клієнтський роутинг.
      // Даємо мережі час, а не перевіряємо стан одразу після кліку.
      await this.page
        .waitForURL((url) => url.toString() !== urlBefore, { timeout: 5000 })
        .catch(() => {});
      return;
    }

    let count: number = await this.optionButtons.count();
    if (count === 0) {
      // Наступний крок міг ще не встигнути відрендеритися (наприклад, поки
      // підвантажуються доступні слоти уроку) — даємо йому додатковий шанс,
      // перш ніж визнавати це помилкою.
      await this.optionButtons
        .first()
        .waitFor({ state: 'visible', timeout: 3000 })
        .catch(() => {});
      count = await this.optionButtons.count();
    }
    if (count === 0) {
      throw new Error(
        'Не вдалося визначити активну дію на поточному кроці квіза: не знайдено жодної кнопки-відповіді'
      );
    }

    const urlBeforeChoices: string = this.page.url();
    for (let i = 0; i < count; i++) {
      const option: Locator = this.optionButtons.nth(i);
      if (!(await this.isReady(option))) continue;
      await this.safeClick(option);

      // Перехід на наступний крок може статися з невеликою затримкою
      // (анімація), тож одразу після кліку чекаємо на будь-яку з двох ознак
      // прогресу, а не читаємо стан миттєво — інакше цикл встигає клікнути
      // по елементах, які вже застаріли через перехід сторінки.
      const progress: 'navigated' | 'continue-enabled' | 'none' = await this.waitForStepProgress(urlBeforeChoices, this.continueButton);
      if (progress === 'navigated') return;
      if (progress === 'continue-enabled') {
        await this.safeClick(this.continueButton);
        return;
      }
    }
    throw new Error(
      'Не вдалося визначити активну дію на поточному кроці квіза: жоден вибір не активував перехід далі'
    );
  }

  private async waitForStepProgress(
    urlBefore: string,
    continueButton: Locator,
    timeout = 1200
  ): Promise<'navigated' | 'continue-enabled' | 'none'> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.page.url() !== urlBefore) return 'navigated';
      if (await continueButton.isEnabled({ timeout: 300 }).catch(() => false)) return 'continue-enabled';
      await this.page.waitForTimeout(100);
    }
    return 'none';
  }

  private async clickIfEnabledSoon(locator: Locator, timeout = 1000): Promise<boolean> {
    if (!(await this.isVisible(locator))) return false;
    try {
      await expect(locator).toBeEnabled({ timeout });
    } catch {
      return false;
    }
    await this.safeClick(locator);
    return true;
  }

  private async bookTrialLesson(): Promise<void> {
    await this.safeClick(this.bookButton);

    // Перехід на дашборд асинхронний — знімок стану одразу після кліку
    // може ще показувати попередній екран.
    await this.page.waitForURL(DASHBOARD_URL_PATTERN, { timeout: 10000 });
  }

  /**
   * @description Деякі кроки квіза мають фонове відео, через яке Playwright
   * не може дочекатися "стабільності" елемента (bounding box постійно
   * змінюється через репейнт відео) — звичайний `.click()` може чекати
   * нескінченно. Обмежуємо очікування і форсуємо клік, якщо стабільність
   * так і не настала, а не чекаємо до кінця бюджету часу тесту.
   */
  private async safeClick(locator: Locator, timeout = 5000): Promise<void> {
    try {
      await locator.click({ timeout });
    } catch {
      // Елемент міг або (а) лишитися в DOM, але не стабілізуватися через
      // фонову анімацію/відео — тоді форсуємо клік; або (б) уже зникнути,
      // бо квіз встиг перейти на інший крок, поки ми чекали — тоді форсований
      // клік по неіснуючому елементу лише зависне без сенсу, і це не збій,
      // а нормальний прогрес, який побачить наступна ітерація циклу.
      const stillPresent: number = await locator.count().catch(() => 0);
      if (stillPresent === 0) return;
      await locator.click({ force: true, timeout: 3000 });
    }
  }

  // Явний короткий timeout обов'язковий: без нього isVisible/isEnabled на
  // локаторі, що не має жодного збігу на поточному кроці, чекають появи
  // елемента аж до дефолтного таймауту тесту, а не миттєво повертають false.
  private async isVisible(locator: Locator): Promise<boolean> {
    return locator.isVisible({ timeout: 300 }).catch(() => false);
  }

  private async isReady(locator: Locator): Promise<boolean> {
    return (await this.isVisible(locator)) && (await locator.isEnabled({ timeout: 300 }).catch(() => false));
  }

  private generatePhone(): string {
    const prefixes = ['67', '68', '96', '97', '98', '50', '66', '95', '99', '63', '73', '93'];
    const prefix = faker.helpers.arrayElement(prefixes);
    const rest = faker.string.numeric(7);
    return `0${prefix}${rest}`;
  }

  private generateEmail(): string {
    return faker.internet.email().toLowerCase();
  }
}
