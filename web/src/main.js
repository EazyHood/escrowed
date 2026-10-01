import './style.css';
import {
  PROGRAM_ID, ACCOUNT_SIZE, DEVNET_RPC, createConnection, inspectEscrow, deriveEscrow, validateListing, assertDevnet, getProgramState,
  parseSol, formatSol, parseDeadline, publicKey, createInstruction, awardInstruction,
  refundInstruction, prepareTransaction, sendPrepared, explorerAddress,
  explorerTransaction, readableError, FieldError,
} from './lib/chain.js';
import { IntentGuard } from './lib/intent.js';

const connection = createConnection();
const $ = (selector) => document.querySelector(selector);
const escape = (value) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const short = (value) => `${String(value).slice(0, 6)}…${String(value).slice(-6)}`;
const date = (value) => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZoneName: undefined }).format(new Date(value * 1000));
const arrow = '<span aria-hidden="true">↗</span>';
let provider = null;
let connectedAddress = null;
let latest = null;
let pending = null;
let sending = false;
let lookupVersion = 0;
const intents = new IntentGuard();

document.querySelector('#app').innerHTML = `
  <header class="site-header wrap">
    <a class="brand" href="${import.meta.env.BASE_URL}" aria-label="Escrowed home"><span class="brand-icon" aria-hidden="true">E<span>↗</span></span>escrowed<span class="brand-period">.</span></a>
    <div class="header-actions"><span class="network"><span aria-hidden="true"></span>Solana devnet</span><button id="wallet-button" class="button button-outline">Connect wallet ${arrow}</button></div>
  </header>
  <main>
    <section class="hero wrap" aria-labelledby="hero-title">
      <div class="hero-copy"><p class="eyebrow"><span class="dash" aria-hidden="true"></span> BOUNTY BACKING, MADE VISIBLE</p>
        <h1 id="hero-title">Before you build,<br>check the <em>backing.</em></h1>
        <p class="hero-description">A promise on a listing. A deposit on Solana.<br>See the difference before you put in the work.</p>
        <p class="hero-footnote" id="deployment-status">Devnet deployment pending. Test SOL only — no real-money prizes.</p>
      </div>
      <aside class="proof-route" aria-label="How verification works">
        <div class="route-heading"><span class="mono">THE VERIFICATION PATH</span><span class="route-icon" aria-hidden="true">⤵</span></div>
        <div class="route-step"><span class="route-number">01</span><div><strong>The exact listing</strong><p>Its URL identifies one bounty.</p></div></div>
        <div class="route-step"><span class="route-number">02</span><div><strong>The sponsor’s address</strong><p>The wallet behind the deposit.</p></div></div>
        <div class="route-step"><span class="route-number">03</span><div><strong>An on-chain receipt</strong><p>Read the balance, state and refund date.</p></div></div>
        <div class="route-footer"><span class="tiny-square" aria-hidden="true"></span> No wallet needed to verify</div>
      </aside>
    </section>
    <section id="workspace" class="workspace wrap" aria-labelledby="workspace-title">
      <div class="workspace-heading"><div><p class="eyebrow">THE WORKSPACE</p><h2 id="workspace-title">Follow the funds.</h2></div><a class="text-link" href="https://github.com/EazyHood/escrowed" target="_blank" rel="noreferrer">Read the source ${arrow}</a></div>
      <div class="workspace-shell">
        <nav class="workspace-nav" aria-label="Choose an escrow workflow"><button id="verify-tab" aria-current="page" data-view="verify"><span>01</span> Verify a bounty</button><button id="fund-tab" data-view="fund"><span>02</span> Fund a bounty</button><button id="manage-tab" data-view="manage"><span>03</span> Settle an escrow</button></nav>
        <div class="workspace-body">
          <section id="verify-view" class="view" aria-labelledby="verify-title">
            <div class="view-top"><div><h3 id="verify-title">Is there a deposit behind it?</h3><p>Read the current state directly from Solana devnet.</p></div><span class="mode-label">READ ONLY</span></div>
            <form id="verify-form" novalidate>
              <div class="field"><label for="verify-listing">Exact listing URL <span class="required">required</span></label><input id="verify-listing" name="listing" type="url" autocomplete="url" spellcheck="false" placeholder="https://example.com/bounties/my-project" required maxlength="2048" aria-describedby="verify-listing-hint verify-listing-error"><p id="verify-listing-hint" class="hint">Copy the URL used to create the escrow. Case, trailing slashes and query parameters matter.</p><p id="verify-listing-error" class="field-error" hidden></p></div>
              <div class="field"><label for="verify-sponsor">Sponsor’s Solana address <span class="required">required</span></label><input id="verify-sponsor" name="sponsor" type="text" autocomplete="off" spellcheck="false" placeholder="The sponsor’s public wallet address" required maxlength="44" aria-describedby="verify-sponsor-hint verify-sponsor-error"><p id="verify-sponsor-hint" class="hint">Get this from the sponsor through a channel you trust. Escrowed does not verify their identity.</p><p id="verify-sponsor-error" class="field-error" hidden></p></div>
              <div id="verify-error" class="notice notice-error" role="alert" hidden></div>
              <div class="form-actions"><button id="verify-submit" type="submit" class="button button-primary">Verify backing <span aria-hidden="true">→</span></button><span class="form-note">No connection. No signature.</span></div>
            </form>
            <div id="examples" class="examples" hidden></div>
            <div id="verification-result" aria-live="polite"></div>
          </section>
          <section id="fund-view" class="view" aria-labelledby="fund-title" hidden>
            <div class="view-top"><div><h3 id="fund-title">Make a deposit others can check.</h3><p>One escrow per sponsor and exact listing URL.</p></div><span class="mode-label">SPONSOR</span></div>
            <p class="notice">Use a wallet set to <strong>devnet</strong> with test SOL. Your deposit stays in the escrow until you award it or someone returns it to you after the refund deadline.</p>
            <form id="fund-form" novalidate>
              <div class="field"><label for="fund-listing">Exact listing URL <span class="required">required</span></label><input id="fund-listing" name="listing" type="url" autocomplete="url" spellcheck="false" placeholder="https://example.com/bounties/my-project" required maxlength="2048" aria-describedby="fund-listing-hint fund-listing-error"><p id="fund-listing-hint" class="hint">This exact URL is hashed into the account address. Choose it once; it cannot be edited.</p><p id="fund-listing-error" class="field-error" hidden></p></div>
              <div class="field-pair"><div class="field"><label for="fund-amount">Prize in test SOL <span class="required">required</span></label><input id="fund-amount" name="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.01" required aria-describedby="fund-amount-hint fund-amount-error"><p id="fund-amount-hint" class="hint">Plus the account’s rent reserve and network fee.</p><p id="fund-amount-error" class="field-error" hidden></p></div><div class="field"><label for="fund-deadline">Refund becomes available <span class="required">required</span></label><input id="fund-deadline" name="deadline" type="datetime-local" autocomplete="off" required aria-describedby="fund-deadline-hint fund-deadline-error"><p id="fund-deadline-hint" class="hint">Your local time: <span id="local-timezone"></span>. This date cannot be changed.</p><p id="fund-deadline-error" class="field-error" hidden></p></div></div>
              <div id="fund-error" class="notice notice-error" role="alert" hidden></div><div class="form-actions"><button type="submit" class="button button-primary">Review deposit <span aria-hidden="true">→</span></button><span class="form-note">Review → simulate → sign</span></div>
            </form>
          </section>
          <section id="manage-view" class="view" aria-labelledby="manage-title" hidden>
            <div class="view-top"><div><h3 id="manage-title">Close the loop.</h3><p>Award the prize once, or return it after the deadline.</p></div><span class="mode-label">SETTLEMENT</span></div>
            <div id="manage-content"><div class="empty-state"><span class="empty-mark" aria-hidden="true">↳</span><h4>Start with a verified receipt.</h4><p>Look up the exact listing and sponsor first. Then choose an action based on its current state.</p><button class="button button-outline" data-view="verify">Verify an escrow <span aria-hidden="true">→</span></button></div></div>
          </section>
        </div>
        <div class="workspace-footer"><span><span class="tiny-square" aria-hidden="true"></span> ALWAYS DEVNET</span><span>No custody keys · Open source · Native SOL only</span></div>
      </div>
    </section>
    <section class="limits wrap" aria-labelledby="limits-title"><div><p class="eyebrow">KNOW THE BOUNDARY</p><h2 id="limits-title">Evidence of a deposit.<br>Not a promise of a win.</h2></div><div class="limits-copy"><p><strong>The sponsor still chooses the winner.</strong> Escrowed does not judge submissions, verify the sponsor’s identity or guarantee that your work gets paid.</p><p>Once the refund deadline arrives, anyone can send the unawarded prize back to the sponsor. A sponsor may also award it after that date; whichever valid settlement happens first wins.</p><p>This experimental program is upgradeable and has not had an independent security audit. Devnet can reset. Use test funds only.</p></div></section>
  </main>
  <footer class="site-footer wrap"><a class="brand brand-small" href="${import.meta.env.BASE_URL}">escrowed<span class="brand-period">.</span></a><span>A receipt you can inspect.</span><a class="text-link" href="${explorerAddress(PROGRAM_ID)}" target="_blank" rel="noreferrer">Devnet program ${arrow}</a></footer>
  <div id="app-message" class="app-message" role="status" hidden></div>
  <dialog id="wallet-dialog" aria-labelledby="wallet-title"><div class="dialog-top"><p class="eyebrow">DEVNET WALLET</p><button class="icon-button" data-close="wallet-dialog" aria-label="Close wallet dialog">×</button></div><h2 id="wallet-title">Choose your wallet.</h2><p class="dialog-description">Use a browser wallet in devnet mode. We never ask for a seed phrase or store a private key.</p><div id="wallet-options"></div><p id="wallet-error" class="notice notice-error" role="alert" hidden></p></dialog>
  <dialog id="transaction-dialog" aria-labelledby="transaction-title"><div class="dialog-top"><p class="eyebrow">REVIEW BEFORE SIGNING</p><button class="icon-button" data-close="transaction-dialog" aria-label="Close transaction preview">×</button></div><h2 id="transaction-title">Review transaction.</h2><div id="transaction-summary"></div><p id="transaction-status" class="notice" role="status"></p><div id="transaction-error" class="notice notice-error" role="alert" hidden></div><div class="dialog-actions"><button id="sign-button" class="button button-primary">Sign & send on devnet <span aria-hidden="true">→</span></button><button class="button button-quiet" data-close="transaction-dialog">Cancel</button></div></dialog>
`;

$('#local-timezone').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
const tomorrow = new Date(Date.now() + 86_400_000);
$('#fund-deadline').value = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}T${String(tomorrow.getHours()).padStart(2, '0')}:${String(tomorrow.getMinutes()).padStart(2, '0')}`;

function notify(message) {
  const element = $('#app-message');
  element.textContent = message; element.hidden = false;
  window.clearTimeout(notify.timer); notify.timer = window.setTimeout(() => { element.hidden = true; }, 5000);
}

function switchView(view, focus = false) {
  invalidatePreview('The selected workflow changed. Close this preview and review the current action again.');
  if ($('#verify-submit').disabled) {
    lookupVersion++;
    $('#verify-submit').disabled = false;
    $('#verify-submit').innerHTML = 'Verify backing <span aria-hidden="true">→</span>';
    $('#verify-submit').removeAttribute('aria-busy');
    $('#verification-result').innerHTML = '<p class="notice" role="status">Lookup cancelled after switching workflows. Verify again to read the current receipt.</p>';
  }
  for (const element of document.querySelectorAll('.view')) element.hidden = element.id !== `${view}-view`;
  for (const element of document.querySelectorAll('.workspace-nav button')) {
    if (element.dataset.view === view) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current');
  }
  if (view === 'manage') renderManage();
  if (focus) { const heading = $(`#${view}-title`); heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
}

function setError(prefix, error) {
  const field = error instanceof FieldError ? $(`#${prefix}-${error.field}`) : null;
  const element = field ? $(`#${prefix}-${error.field}-error`) : $(`#${prefix}-error`);
  if (element) { element.textContent = readableError(error); element.hidden = false; }
  if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
}

function clearErrors(prefix) {
  for (const element of document.querySelectorAll(`[id^="${prefix}-"][id$="-error"]`)) element.hidden = true;
  const error = $(`#${prefix}-error`); if (error) error.hidden = true;
  for (const element of document.querySelectorAll(`#${prefix}-form [aria-invalid]`)) element.removeAttribute('aria-invalid');
}

function addressRow(label, address) {
  const encoded = escape(address);
  return `<div class="receipt-row"><dt>${escape(label)}</dt><dd><span class="address-text" title="${encoded}">${encoded}</span><div class="address-actions"><button class="copy-button" data-copy="${encoded}" aria-label="Copy ${escape(label.toLowerCase())}">Copy</button><a href="${explorerAddress(encoded)}" target="_blank" rel="noreferrer" aria-label="Open ${escape(label.toLowerCase())} in Solana Explorer">Explorer ${arrow}</a></div></dd></div>`;
}

function renderReceipt(result) {
  const container = $('#verification-result');
  const { account, derived, slot, checkedAt } = result;
  if (!account) {
    container.innerHTML = `<article class="receipt receipt-empty"><div class="receipt-head"><span class="eyebrow">LOOKUP RESULT</span><span class="stamp stamp-neutral">NO ESCROW FOUND</span></div><h4>No receipt at this address.</h4><p>This does not prove the listing is fraudulent. Check the exact URL and sponsor address, or ask the sponsor to fund an escrow.</p><dl>${addressRow('Derived escrow', derived.address.toBase58())}</dl><p class="receipt-foot">Devnet · checked at slot ${slot.toLocaleString('en')}</p></article>`;
    renderManage(); return;
  }
  const deadlinePassed = Date.now() / 1000 >= account.deadline;
  const heading = account.status === 'Funded' ? 'Deposit verified.' : account.status === 'Awarded' ? 'This prize was awarded.' : 'This prize was refunded.';
  const statusLabel = account.status === 'Funded' ? 'FUNDED ON DEVNET' : account.status.toUpperCase();
  const explanation = account.status === 'Funded' ? (deadlinePassed ? 'The prize is still deposited, but its refund date has passed. Anyone may return it to the sponsor now.' : 'The account covers the stated prize and its rent reserve at the checked slot. The sponsor still selects the winner.') : account.status === 'Awarded' ? 'The receipt records a completed award. The original prize is no longer available to other applicants.' : 'The receipt records a refund to the sponsor. The original prize is no longer available.';
  container.innerHTML = `<article class="receipt ${account.status === 'Funded' ? 'receipt-funded' : ''}"><div class="receipt-head"><span class="eyebrow">ON-CHAIN RECEIPT</span><span class="stamp ${account.status === 'Funded' ? 'stamp-funded' : 'stamp-neutral'}">${statusLabel}</span></div><h4>${heading}</h4><div class="receipt-prize"><strong>${formatSol(account.amount)}</strong><span>test SOL<br><small>${account.status === 'Funded' ? 'deposited prize' : 'original prize'}</small></span></div><p class="receipt-explanation">${explanation}</p><dl><div class="receipt-row"><dt>Listing identifier</dt><dd class="listing-wrap"><a href="${escape(account.listing)}" target="_blank" rel="noreferrer">${escape(account.listing)} ${arrow}</a><span class="hint">URL match only; the listing’s contents and author are not verified.</span></dd></div>${addressRow('Sponsor', account.sponsor.toBase58())}${addressRow('Escrow account', account.address.toBase58())}<div class="receipt-row"><dt>Refund available</dt><dd>${date(account.deadline)} <span class="hint">${new Date(account.deadline * 1000).toISOString()} · ${deadlinePassed ? 'Date has passed' : 'After this date, the sponsor may recover the unawarded prize'}</span></dd></div>${account.status === 'Awarded' ? addressRow('Recorded recipient', account.winner.toBase58()) : ''}<div class="receipt-row"><dt>Account balance</dt><dd>${formatSol(account.balance)} test SOL<span class="hint">Includes ${formatSol(account.rentReserve)} SOL reserved for account rent.</span></dd></div></dl><details class="verification-details"><summary>What was actually checked?</summary><ul><li>Devnet genesis hash and executable Escrowed program</li><li>Program ownership, 122-byte layout and account discriminator</li><li>Exact URL hash, sponsor, canonical PDA and bump</li><li>Settlement fields and balance covering ${account.status === 'Funded' ? 'prize plus' : 'the'} rent reserve</li></ul><p>No sponsor identity, work quality or eventual payment is verified.</p></details><div class="receipt-actions"><button class="button button-outline" data-share>Copy verification link ${arrow}</button><button class="button button-quiet" data-view="manage">Settlement options <span aria-hidden="true">→</span></button></div><p class="receipt-foot">Devnet · slot ${slot.toLocaleString('en')} · ${new Date(checkedAt).toLocaleTimeString('en')} local · <button class="inline-button" data-refresh>Refresh state</button></p></article>`;
  renderManage();
}

function renderManage() {
  const state = latest?.account;
  const container = $('#manage-content');
  if (!state) {
    container.innerHTML = `<div class="empty-state"><span class="empty-mark" aria-hidden="true">↳</span><h4>${latest ? 'No escrow to settle.' : 'Start with a verified receipt.'}</h4><p>${latest ? 'This exact listing and sponsor did not resolve to an escrow. Check their details before choosing a settlement.' : 'Look up the exact listing and sponsor first. Settlement options appear only after a successful account verification.'}</p><button class="button button-outline" data-view="verify">Verify an escrow <span aria-hidden="true">→</span></button></div>`;
    return;
  }
  const isSponsor = connectedAddress === state.sponsor.toBase58();
  container.innerHTML = `<div class="settlement-heading"><span class="stamp stamp-neutral">${state.status.toUpperCase()}</span><strong>${formatSol(state.amount)} <small>test SOL</small></strong></div><p class="hint listing-wrap">${escape(state.listing)}</p><dl class="compact-receipt">${addressRow('Sponsor', state.sponsor.toBase58())}${addressRow('Escrow', state.address.toBase58())}</dl>${state.status !== 'Funded' ? `<div class="notice">This escrow is already ${state.status.toLowerCase()}. Its original prize cannot be awarded or refunded again.</div><button class="button button-outline" data-refresh>Refresh receipt</button>` : `<div class="settlement-options"><form id="award-form" novalidate><p class="eyebrow">OPTION A · SPONSOR ONLY</p><h4>Award the prize.</h4><p>Send the full prize to one recipient. This settlement cannot be undone.</p>${!isSponsor ? '<p class="hint">Connect the original sponsor wallet to award this escrow.</p>' : ''}<div class="field"><label for="award-winner">Winner’s public address <span class="required">required</span></label><input id="award-winner" type="text" autocomplete="off" spellcheck="false" maxlength="44" placeholder="Recipient’s Solana address" required aria-describedby="award-winner-error"><p id="award-winner-error" class="field-error" hidden></p></div><div id="award-error" class="notice notice-error" role="alert" hidden></div><button class="button button-primary" type="submit">Review award <span aria-hidden="true">→</span></button></form><div class="refund-section"><p class="eyebrow">OPTION B · AFTER THE DEADLINE</p><h4>Return it to the sponsor.</h4><p>Anyone may trigger the refund after ${date(state.deadline)}. The caller only pays the transaction fee.</p><div id="refund-error" class="notice notice-error" role="alert" hidden></div><button class="button button-outline" id="refund-button">Review refund <span aria-hidden="true">→</span></button><p class="hint">The chain checks its own clock. No funds can be redirected.</p></div></div>`}`;
  $('#award-form')?.addEventListener('submit', reviewAward);
  $('#refund-button')?.addEventListener('click', reviewRefund);
}

async function verify(event) {
  event?.preventDefault(); clearErrors('verify');
  invalidatePreview('A new verification started. Close this preview and review its fresh receipt before signing.');
  const version = ++lookupVersion;
  const button = $('#verify-submit'); button.disabled = true; button.textContent = 'Reading devnet…'; button.setAttribute('aria-busy', 'true');
  $('#verification-result').innerHTML = '<div class="lookup-loading" role="status"><span class="loading-line"></span>Deriving the escrow address and checking its account…</div>';
  latest = null;
  $('#manage-content').innerHTML = '<div class="empty-state"><h4>Verification pending.</h4><p>Complete a successful lookup before settling an escrow.</p><button class="button button-outline" data-view="verify">Return to verification</button></div>';
  try {
    const result = await inspectEscrow(connection, $('#verify-listing').value, $('#verify-sponsor').value);
    if (version !== lookupVersion) return;
    latest = result; renderReceipt(result);
  } catch (error) { if (version === lookupVersion) { $('#verification-result').innerHTML = ''; setError('verify', error); } }
  finally { if (version === lookupVersion) { button.disabled = false; button.innerHTML = 'Verify backing <span aria-hidden="true">→</span>'; button.removeAttribute('aria-busy'); } }
}
$('#verify-form').addEventListener('submit', verify);
$('#verify-form').addEventListener('input', () => {
  if (!latest && !$('#verify-submit').disabled) return;
  lookupVersion++; latest = null;
  $('#verification-result').innerHTML = '<p class="notice" role="status">Details changed. Verify again to read the receipt for this listing and sponsor.</p>';
  $('#verify-submit').disabled = false;
  $('#verify-submit').innerHTML = 'Verify backing <span aria-hidden="true">→</span>';
  $('#verify-submit').removeAttribute('aria-busy');
  renderManage();
});

function requireWallet() {
  if (!provider?.publicKey || !connectedAddress) { openWalletDialog(); throw new Error('Connect a devnet wallet, then review the action again.'); }
  return provider.publicKey;
}

async function reviewFund(event) {
  event.preventDefault(); clearErrors('fund');
  const button = event.submitter; button.disabled = true; button.textContent = 'Checking deposit…';
  try {
    const listing = validateListing($('#fund-listing').value);
    const amount = parseSol($('#fund-amount').value);
    const deadline = parseDeadline($('#fund-deadline').value);
    const payer = requireWallet();
    const intent = intents.begin();
    const derived = await deriveEscrow(listing, payer);
    intent.assertCurrent();
    const [existing, rent] = await Promise.all([connection.getAccountInfo(derived.address, 'confirmed'), connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, 'confirmed')]);
    intent.assertCurrent();
    if (existing) throw new Error('This sponsor already has a receipt for this exact URL, including settled escrows. Verify it instead.');
    const instruction = await createInstruction(derived, amount, deadline);
    const prepared = await prepareTransaction(connection, payer, instruction);
    intent.assertCurrent();
    const balance = BigInt(await connection.getBalance(payer, 'confirmed'));
    intent.assertCurrent();
    if (balance < amount + BigInt(rent) + prepared.fee) throw new Error('The connected wallet does not have enough devnet SOL for the prize, account rent and fee. Add test SOL and try again.');
    showPreview({ intent, kind: 'Fund bounty', prepared, amount, rent: BigInt(rent), derived, deadline, payer, destination: derived.address, description: 'The prize and account rent move from your wallet into this escrow. The sponsor can award the prize; after the deadline, anyone can refund the prize to the sponsor. The receipt and rent remain on chain.' });
  } catch (error) { setError('fund', error); }
  finally { button.disabled = false; button.innerHTML = 'Review deposit <span aria-hidden="true">→</span>'; }
}
$('#fund-form').addEventListener('submit', reviewFund);

async function freshState(intent) {
  if (!latest?.account) throw new Error('Verify an escrow first.');
  const result = await inspectEscrow(connection, latest.account.listing, latest.account.sponsor);
  intent.assertCurrent();
  if (!result.account) throw new Error('The escrow no longer exists. Refresh its receipt.');
  latest = result;
  if (result.account.status !== 'Funded') { renderReceipt(result); throw new Error('The escrow was already settled. Its receipt has been updated.'); }
  return result.account;
}

async function reviewAward(event) {
  event.preventDefault(); clearErrors('award');
  const button = event.submitter; button.disabled = true; button.textContent = 'Checking award…';
  try {
    const winner = publicKey($('#award-winner').value, 'winner'); const payer = requireWallet();
    const intent = intents.begin();
    const state = await freshState(intent);
    if (!payer.equals(state.sponsor)) throw new Error('Only the original sponsor wallet can award this escrow. Connect that wallet first.');
    const winnerInfo = await connection.getAccountInfo(winner, 'confirmed');
    intent.assertCurrent();
    if (winnerInfo?.executable) throw new FieldError('winner', 'The recipient is an executable program. Use the winner’s wallet address.');
    const instruction = await awardInstruction(state, winner);
    const prepared = await prepareTransaction(connection, payer, instruction);
    intent.assertCurrent();
    const derived = await deriveEscrow(state.listing, state.sponsor);
    intent.assertCurrent();
    showPreview({ intent, kind: 'Award prize', prepared, amount: state.amount, rent: 0n, derived, deadline: state.deadline, payer, destination: winner, description: 'The full prize leaves the escrow for this recipient. The account retains its rent reserve and records the winner permanently. The connected sponsor pays the network fee.' });
  } catch (error) { setError('award', error); }
  finally { button.disabled = false; button.innerHTML = 'Review award <span aria-hidden="true">→</span>'; }
}

async function reviewRefund(event) {
  clearErrors('refund'); const button = event.currentTarget; button.disabled = true; button.textContent = 'Checking refund…';
  try {
    const payer = requireWallet(); const intent = intents.begin(); const state = await freshState(intent);
    // The program, not the device clock, decides whether the deadline passed.
    const instruction = await refundInstruction(state, payer);
    const prepared = await prepareTransaction(connection, payer, instruction);
    intent.assertCurrent();
    const derived = await deriveEscrow(state.listing, state.sponsor);
    intent.assertCurrent();
    showPreview({ intent, kind: 'Refund prize', prepared, amount: state.amount, rent: 0n, derived, deadline: state.deadline, payer, destination: state.sponsor, description: 'The full prize returns to the original sponsor. It cannot be redirected to the caller. The account keeps its rent reserve; the connected wallet pays the network fee.' });
  } catch (error) { setError('refund', error); }
  finally { button.disabled = false; button.innerHTML = 'Review refund <span aria-hidden="true">→</span>'; }
}

function showPreview(details) {
  details.intent.assertCurrent();
  details.prepared.assertCurrent = details.intent.assertCurrent;
  pending = details;
  $('#transaction-title').textContent = `${details.kind} on devnet.`;
  $('#transaction-error').hidden = true;
  $('#transaction-summary').innerHTML = `<p class="dialog-description">${escape(details.description)}</p><div class="preview-amount"><strong>${formatSol(details.amount)}</strong><span>test SOL</span></div><dl class="preview-rows"><div class="receipt-row"><dt>Network</dt><dd>Solana devnet · test funds only</dd></div><div class="receipt-row"><dt>Exact listing URL</dt><dd class="listing-wrap">${escape(details.derived.listing)}<span class="hint">This exact text, without silent normalization, identifies the bounty.</span></dd></div>${addressRow(details.kind === 'Fund bounty' ? 'New escrow account' : 'Source escrow account', details.derived.address.toBase58())}${addressRow('Sponsor', details.derived.sponsor.toBase58())}${addressRow('Signing wallet', details.payer.toBase58())}${addressRow('Destination', details.destination.toBase58())}${addressRow('Program', PROGRAM_ID.toBase58())}<div class="receipt-row"><dt>Network fee estimate</dt><dd>${formatSol(details.prepared.fee)} SOL</dd></div>${details.rent ? `<div class="receipt-row"><dt>Account rent reserve</dt><dd>${formatSol(details.rent)} SOL</dd></div><div class="receipt-row"><dt>Total wallet debit</dt><dd>${formatSol(details.amount + details.rent + details.prepared.fee)} SOL</dd></div>` : `<div class="receipt-row"><dt>Wallet debit for fee</dt><dd>${formatSol(details.prepared.fee)} SOL</dd></div>`}<div class="receipt-row"><dt>Refund available</dt><dd>${date(details.deadline)}<span class="hint">${new Date(details.deadline * 1000).toISOString()}</span></dd></div></dl>`;
  $('#transaction-status').textContent = `Simulation passed${details.prepared.units !== undefined ? ` · ${details.prepared.units.toLocaleString('en')} compute units` : ''}. No transaction has been signed or sent.`;
  $('#sign-button').disabled = false; $('#sign-button').hidden = false;
  $('#transaction-dialog').showModal();
}

$('#sign-button').addEventListener('click', async () => {
  if (!pending || sending) return;
  const current = pending; sending = true; $('#sign-button').disabled = true;
  $('#transaction-error').hidden = true;
  for (const button of document.querySelectorAll('[data-close="transaction-dialog"]')) button.disabled = true;
  try {
    current.intent.assertCurrent();
    const signature = await sendPrepared(connection, provider, current.prepared, (stage, tx) => {
      const text = { signature: 'Waiting for you to approve in your wallet…', sending: 'Sending the signed transaction to devnet…', confirming: 'Submitted. Waiting for on-chain confirmation…', confirmed: 'Confirmed on Solana devnet.' }[stage];
      $('#transaction-status').innerHTML = `${escape(text)}${tx ? `<br><a class="text-link" href="${explorerTransaction(tx)}" target="_blank" rel="noreferrer">Inspect transaction ${arrow}</a>` : ''}`;
    });
    $('#sign-button').hidden = true;
    $('#verify-listing').value = current.derived.listing; $('#verify-sponsor').value = current.derived.sponsor.toBase58();
    switchView('verify'); await verify();
    notify('Transaction confirmed. You can inspect its receipt in Solana Explorer.');
    pending = null;
    return signature;
  } catch (error) {
    $('#transaction-error').textContent = `${readableError(error)} If a signature is shown above, inspect it before retrying.`;
    $('#transaction-error').hidden = false;
    // A new simulation is needed, and an uncertain send must not be duplicated.
    $('#sign-button').hidden = true;
    pending = null;
  } finally {
    sending = false;
    for (const button of document.querySelectorAll('[data-close="transaction-dialog"]')) button.disabled = false;
  }
});

function openWalletDialog() {
  $('#wallet-error').hidden = true;
  if (connectedAddress) {
    $('#wallet-options').innerHTML = `<div class="wallet-connected"><p class="eyebrow">CONNECTED</p><p class="address-text">${escape(connectedAddress)}</p><button class="button button-outline" data-copy="${escape(connectedAddress)}">Copy wallet address</button><a class="text-link" href="${explorerAddress(connectedAddress)}" target="_blank" rel="noreferrer">View on devnet ${arrow}</a><button class="button button-quiet" id="disconnect-wallet">Disconnect</button></div>`;
    $('#disconnect-wallet').addEventListener('click', async () => { await provider?.disconnect?.(); resetWallet(); $('#wallet-dialog').close(); });
  } else {
    const phantom = window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null);
    const solflare = window.solflare?.isSolflare ? window.solflare : null;
    const wallets = [{ name: 'Phantom', provider: phantom, url: 'https://phantom.com/download' }, { name: 'Solflare', provider: solflare, url: 'https://solflare.com/download' }];
    $('#wallet-options').innerHTML = wallets.map((wallet, i) => wallet.provider ? `<button class="wallet-option" data-wallet="${i}"><span>${wallet.name}</span><span>Connect ${arrow}</span></button>` : `<a class="wallet-option" href="${wallet.url}" target="_blank" rel="noreferrer"><span>${wallet.name}</span><span>Install ${arrow}</span></a>`).join('');
    for (const button of document.querySelectorAll('[data-wallet]')) button.addEventListener('click', async () => {
      const selected = wallets[Number(button.dataset.wallet)]; button.disabled = true; button.textContent = 'Waiting for wallet…';
      try {
        await selected.provider.connect();
        provider = selected.provider;
        if (!provider.publicKey || typeof provider.signTransaction !== 'function') throw new Error('This wallet does not support transaction signing.');
        connectedAddress = provider.publicKey.toBase58();
        $('#wallet-button').textContent = short(connectedAddress);
        provider.on?.('disconnect', resetWallet);
        provider.on?.('accountChanged', account => { if (!account) resetWallet(); else { connectedAddress = account.toBase58(); invalidatePreview(); $('#wallet-button').textContent = short(connectedAddress); renderManage(); } });
        $('#wallet-dialog').close(); renderManage();
        notify(`${selected.name} connected. Transactions use devnet test SOL only.`);
      } catch (error) { $('#wallet-error').textContent = readableError(error); $('#wallet-error').hidden = false; button.disabled = false; button.textContent = `Retry ${selected.name}`; }
    });
  }
  $('#wallet-dialog').showModal();
}

function resetWallet() {
  provider = null; connectedAddress = null; invalidatePreview();
  $('#wallet-button').innerHTML = `Connect wallet ${arrow}`; renderManage();
}
function invalidatePreview(message = 'The connected wallet changed. Close this preview and review the action again.') {
  intents.invalidate();
  if (pending && !sending) {
    $('#transaction-error').textContent = message;
    $('#transaction-error').hidden = false;
    $('#sign-button').hidden = true;
  }
  pending = null;
}
$('#wallet-button').addEventListener('click', openWalletDialog);
document.addEventListener('input', event => {
  if (event.target.closest('#fund-form, #award-form, #verify-form')) invalidatePreview('The form details changed. Close this preview and review the current details again.');
});

document.addEventListener('click', async event => {
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) switchView(viewButton.dataset.view, true);
  const closeButton = event.target.closest('[data-close]');
  if (closeButton && !sending) { $(`#${closeButton.dataset.close}`).close(); if (closeButton.dataset.close === 'transaction-dialog') invalidatePreview(); }
  const copyButton = event.target.closest('[data-copy]');
  if (copyButton) { try { await navigator.clipboard.writeText(copyButton.dataset.copy); notify('Address copied.'); } catch { notify('Copy was blocked by the browser. Select and copy the full address instead.'); } }
  if (event.target.closest('[data-share]') && latest?.account) {
    const link = new URL(import.meta.env.BASE_URL, location.origin); link.searchParams.set('listing', latest.account.listing); link.searchParams.set('sponsor', latest.account.sponsor.toBase58());
    try { await navigator.clipboard.writeText(link.href); notify('Verification link copied.'); } catch { notify('The browser blocked copying. You can share the exact listing and sponsor instead.'); }
  }
  if (event.target.closest('[data-refresh]')) { switchView('verify'); await verify(); }
});

$('#transaction-dialog').addEventListener('cancel', event => { if (sending) event.preventDefault(); else invalidatePreview(); });

const initial = new URLSearchParams(location.search);
if (initial.has('listing')) $('#verify-listing').value = initial.get('listing');
if (initial.has('sponsor')) $('#verify-sponsor').value = initial.get('sponsor');
if (initial.has('listing') || initial.has('sponsor')) notify('Shared details loaded. Select “Verify backing” to read their current state.');

fetch(`${import.meta.env.BASE_URL}examples.json`, { signal: AbortSignal.timeout(8000) })
  .then(response => response.ok ? response.json() : null)
  .then(data => {
    if (!Array.isArray(data?.examples) || !data.examples.length) return;
    const examples = data.examples.filter(item => typeof item.listing === 'string' && typeof item.sponsor === 'string' && typeof item.label === 'string').slice(0, 5);
    if (!examples.length) return;
    $('#examples').hidden = false;
    $('#examples').innerHTML = `<span class="hint">Try a recorded devnet example:</span><div>${examples.map((item, index) => `<button class="example-button" data-example="${index}">${escape(item.label)} <span aria-hidden="true">↗</span></button>`).join('')}</div><p class="hint">These are test deposits, not customer bounties. Their current state is always fetched afresh.</p>`;
    for (const button of document.querySelectorAll('[data-example]')) button.addEventListener('click', () => { const item = examples[Number(button.dataset.example)]; $('#verify-listing').value = item.listing; $('#verify-sponsor').value = item.sponsor; verify(); });
  }).catch(() => { /* Examples are optional; the verifier still works. */ });

// Publication records must explicitly contain completed devnet evidence before
// the page can call itself live. Recheck the program from devnet as well.
fetch(`${import.meta.env.BASE_URL}deployment.json`, { signal: AbortSignal.timeout(8000) })
  .then(response => response.ok ? response.json() : null)
  .then(async data => {
    if (data?.status !== 'verified' || data.programId !== PROGRAM_ID.toBase58() || typeof data.evidence !== 'string' || !data.evidence) return;
    await assertDevnet(connection);
    if ((await getProgramState(connection)).deployed) $('#deployment-status').textContent = 'Live on Solana devnet. Test SOL only — no real-money prizes.';
    else $('#deployment-status').textContent = 'Devnet program currently unavailable. Test SOL only — no real-money prizes.';
  }).catch(() => { $('#deployment-status').textContent = 'Devnet status not verified in this browser. Test SOL only — no real-money prizes.'; });

// Expose only non-sensitive build metadata, not provider or wallet internals.
console.info(`Escrowed devnet client · program ${PROGRAM_ID.toBase58()} · RPC ${DEVNET_RPC}`);
