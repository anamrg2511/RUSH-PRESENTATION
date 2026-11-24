import { expect, test, type Page } from '@playwright/test';

const suffix = () => Math.random().toString(36).slice(2, 8);
const PASSWORD = 'e2e-password-1234';

async function register(page: Page, username: string) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill(`E2E ${username}`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Email').fill(`${username}@e2e.test`);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: /Hi, E2E/ })).toBeVisible();
}

test('public landing page: hero, learn more, navigation drawer and CTA into the app', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Quizzes at full speed/ })).toBeVisible();
  // "Learn more" scrolls to the information section
  await page.getByRole('button', { name: 'Learn more' }).click();
  await expect(page.getByRole('heading', { name: 'Why RUSH!' })).toBeInViewport();
  // hamburger opens a working drawer with the existing sections
  await page.getByRole('button', { name: 'Menu' }).click();
  const drawer = page.getByRole('dialog', { name: 'Menu' });
  for (const name of ['Home', 'Dashboard', 'Rooms', 'Quizzes', 'Vocabulary', 'Log in', 'Create account']) {
    await expect(drawer.getByRole('link', { name })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  // the profile icon goes to login for visitors; "Try it now!" uses the normal auth flow
  await expect(page.getByRole('link', { name: 'Log in' }).first()).toHaveAttribute('href', '/login');
  await page.getByRole('link', { name: /Try it now!/ }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});

test('register, log out and log back in', async ({ page }) => {
  const name = `auth_${suffix()}`;
  await register(page, name);
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.getByLabel('Username or email').fill(name);
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toContainText('Incorrect');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: /Hi, E2E/ })).toBeVisible();
});

test('host and player: room, invitation, quiz, global timer, highest score wins', async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const player = await playerCtx.newPage();
  const hostName = `host_${suffix()}`;
  const playerName = `player_${suffix()}`;
  await register(host, hostName);
  await register(player, playerName);

  // host creates a private room
  await host.goto('/rooms?new=1');
  await host.getByLabel('Room name').fill('E2E Room');
  await host.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(host).toHaveURL(/\/rooms\/\d+$/);
  const roomUrl = host.url();

  // invitation link (shown once)
  await host.getByRole('tab', { name: 'Invitations' }).click();
  await host.getByRole('button', { name: 'Create invitation link' }).click();
  const inviteUrl = await host.getByLabel('Invitation link').inputValue();
  expect(inviteUrl).toMatch(/\/invite\/[A-Za-z0-9_-]+$/);

  // player joins through the link
  await player.goto(new URL(inviteUrl).pathname);
  await expect(player.getByRole('heading', { name: 'E2E Room' })).toBeVisible();
  await player.getByRole('button', { name: 'Join room' }).click();
  await expect(player).toHaveURL(/\/rooms\/\d+$/);
  await expect(player.getByText('Member', { exact: true }).first()).toBeVisible();

  // host builds and publishes a quiz
  await host.goto('/quizzes?new=1');
  await host.getByLabel('Title').fill('E2E Quiz');
  await host.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(host).toHaveURL(/\/quizzes\/\d+$/);
  // one global time limit for the whole quiz (no per-question time field any more)
  await host.getByLabel('Total time limit (minutes)').fill('2');
  await host.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(host.getByText('⏱ 2 min total')).toBeVisible();
  const dialog = host.getByRole('dialog');
  for (const [text, right, wrong] of [
    ['Which one is correct?', 'Right answer', 'Wrong answer'],
    ['Second question?', 'Yes', 'No'],
  ]) {
    await host.getByRole('button', { name: /Add question/ }).first().click();
    await expect(dialog.getByLabel(/Time limit/)).toHaveCount(0);
    await dialog.getByLabel('Question', { exact: true }).fill(text!);
    await dialog.getByLabel('Option 1').fill(right!);
    await dialog.getByLabel('Option 2').fill(wrong!);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(host.getByText(text!)).toBeVisible();
  }
  await host.getByRole('button', { name: 'Publish' }).click();
  await expect(host.getByText('Published', { exact: true })).toBeVisible();

  // add the quiz to the room and start a session
  await host.goto(roomUrl);
  await host.getByRole('button', { name: /Add quiz/ }).click();
  await host.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(host.getByRole('heading', { name: 'E2E Quiz' })).toBeVisible();
  await host.getByRole('button', { name: /Start session/ }).click();
  await expect(host).toHaveURL(/\/play\/\d+$/);
  await expect(host.getByRole('heading', { name: 'Waiting room' })).toBeVisible();

  // player opens the waiting room from the room page
  await player.goto(roomUrl);
  await player.getByRole('link', { name: 'Open session' }).click();
  await expect(player.getByRole('heading', { name: 'Waiting room' })).toBeVisible();
  await expect(host.getByText('Players (2)')).toBeVisible();
  await expect(player.getByRole('button', { name: /Start game/ })).toHaveCount(0); // members cannot start
  for (const p of [host, player]) await expect(p.getByText('2 min for the whole quiz · the highest score wins')).toBeVisible();

  await host.getByRole('button', { name: /Start game/ }).click();
  for (const p of [host, player]) {
    await expect(p.getByRole('heading', { name: 'Which one is correct?' })).toBeVisible();
    await expect(p.getByRole('timer')).toHaveText(/^[12]:\d\d$/); // global clock, m:ss out of 2:00
    await expect(p.getByText('of 2 min')).toBeVisible();
  }

  // host answers the first question wrong, then moves on to the second question
  await host.getByRole('radio', { name: /Wrong answer/ }).click();
  await host.getByRole('button', { name: 'Submit answer' }).click();
  await expect(host.getByRole('heading', { name: 'Not quite' })).toBeVisible();
  await expect(host.getByRole('heading', { name: 'Second question?' })).toBeVisible();

  // the player advances independently; the global timer keeps running (it does not restart at 2:00)
  await player.getByRole('radio', { name: /Right answer/ }).click();
  await player.getByRole('button', { name: 'Submit answer' }).click();
  await expect(player.getByRole('heading', { name: 'Correct!' })).toBeVisible();
  await expect(player.getByRole('heading', { name: 'Second question?' })).toBeVisible();
  await expect(player.getByRole('timer')).not.toHaveText('2:00');
  await expect(player.getByRole('timer')).toHaveText(/^1:\d\d$/);

  // the player answers the last question first (200 points) and finishes. Finishing first ENDS the
  // session for everyone immediately — the host, still on the second question, is cut off — but the
  // winner is decided by score, so the player's higher score (200 vs the host's 0) wins.
  await player.getByRole('radio', { name: /Yes/ }).click();
  await player.getByRole('button', { name: 'Submit answer' }).click();
  for (const p of [host, player]) await expect(p.getByRole('heading', { name: 'Game over' })).toBeVisible();
  await expect(player.getByText('You have the highest score — you win!')).toBeVisible();
  await expect(host.getByText(`E2E ${playerName} wins with the highest score!`)).toBeVisible();
  await expect(host.getByRole('button', { name: 'Submit answer' })).toHaveCount(0); // the host was cut off
  await player.getByRole('link', { name: 'See my results' }).click();
  await expect(player.getByText('Your score')).toBeVisible();
  await expect(player.getByText('You have the highest score — you win!')).toBeVisible();
  await expect(player.getByText(/^200/).first()).toBeVisible();

  // the session appears in the room history
  await host.goto(roomUrl);
  await host.getByRole('tab', { name: 'History' }).click();
  await expect(host.getByText('Completed')).toBeVisible();

  await hostCtx.close();
  await playerCtx.close();
});

test('word translation popup, saving and vocabulary management', async ({ page }) => {
  await register(page, `vocab_${suffix()}`);
  // interactive controls are never translated
  await page.getByRole('button', { name: 'Log out' }).hover();
  await page.getByText('New room').evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('heading', { name: 'Recent results' }).dblclick({ position: { x: 8, y: 8 } });
  const popup = page.getByRole('dialog', { name: 'Recent' });
  await expect(popup).toBeVisible();
  await expect(popup).toContainText('[mock ko] recent');
  await expect(popup).toContainText('[mock explanation]');
  await popup.getByRole('button', { name: 'Save word' }).click();
  await expect(popup).toContainText('Saved');

  await page.getByRole('link', { name: 'Vocabulary' }).first().click();
  await expect(page.getByText('[mock ko] recent')).toBeVisible();
  await page.getByRole('button', { name: 'Favorite' }).click();
  await page.getByLabel('Favorites only').check();
  await expect(page.getByText('[mock ko] recent')).toBeVisible();
  await page.getByLabel('Personal note').fill('seen on the dashboard');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByLabel('Favorites only').uncheck();
  await page.getByLabel('Search words, translations or notes').fill('dashboard');
  await expect(page.getByText('[mock ko] recent')).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('No words match your search.')).toBeVisible();
});

test('interface stays in English; translation target can still be changed', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: '한국어' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

  await register(page, `lang_${suffix()}`);
  await page.goto('/settings');
  const iface = page.getByLabel('Interface language');
  await expect(iface).toHaveValue('ENGLISH');
  await iface.selectOption('KOREAN');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(iface).toHaveValue('ENGLISH');

  const target = page.getByLabel('Translate words into');
  const next = (await target.inputValue()) === 'KOREAN' ? 'ENGLISH' : 'KOREAN';
  const saved = page.waitForResponse((r) => r.url().includes('/api/me/preferences') && r.request().method() === 'PATCH');
  await target.selectOption(next);
  expect((await saved).status()).toBe(200);
  await page.reload();
  await expect(page.getByLabel('Translate words into')).toHaveValue(next);
  await expect(page.getByLabel('Interface language')).toHaveValue('ENGLISH');
});

/*
=========================================================
EXPLICACIÓN DEL ARCHIVO
=========================================================

Propósito: Pruebas de extremo a extremo con Playwright sobre la aplicación completa (navegador real,
backend y MySQL).

Responsabilidades principales:
- Página de inicio: sección principal, "Learn more", menú y botón de acceso.
- Registro, cierre e inicio de sesión.
- Anfitrión y jugador: sala, invitación, cuestionario con tiempo global, partida en vivo con
  temporizador global, el primero en terminar gana y resultados.
- Traducción de palabras y gestión del vocabulario.
- Interfaz solo en inglés y cambio del idioma destino de traducción.

Elementos importantes:
- 5 pruebas
- register(page, username)

Dependencias:
- @playwright/test

Flujo de datos:
Controla navegadores que usan la interfaz como un usuario real.

Aspectos técnicos importantes:
- Usa dos contextos de navegador para simular dos jugadores.

Lugar en la arquitectura:
Pruebas automatizadas. Demuestra que los flujos principales funcionan de punta a punta.
*/
