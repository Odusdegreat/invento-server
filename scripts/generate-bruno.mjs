import { mkdir, writeFile, readFile } from 'node:fs/promises';
const origin = process.env.API_BASE_URL;
const doc = origin ? await (await fetch(origin + '/api/docs-json')).json() : JSON.parse(await readFile(new URL('../docs/openapi.json',import.meta.url),'utf8'));
await mkdir('bruno/environments', { recursive: true });
await writeFile(
  'bruno/bruno.json',
  JSON.stringify(
    {
      version: '1',
      name: 'Invento API',
      type: 'collection',
      ignore: ['node_modules', '.git'],
    },
    null,
    2,
  ),
);
await writeFile(
  'bruno/environments/Local.bru',
  `vars {
  baseUrl: http://localhost:3000
  email: odue@inveto.app
  password: replace-with-SEED_DEMO_PASSWORD
  pin: 4826
  action: transfer
  accessToken:
  refreshToken:
  stepUpToken:
  accountId:
  beneficiaryId:
  transactionId:
  transferId:
  productId:
  cardId:
  notificationId:
  deviceId:
  resetToken:
  verificationToken:
  setupToken:
  challengeToken:
  otpCode:
  credentialId:
  pushTokenId:
  orderId:
  idempotencyKey: manual-intent-001
}
`,
);
const bodies = {
  LoginDto: {
    email: '{{email}}',
    password: '{{password}}',
    deviceName: 'Bruno',
  },
  RegisterDto: {
    email: '{{email}}',
    password: '{{password}}',
    fullName: 'Demo Customer',
    phone: '+15550102288',
    deviceName: 'Bruno',
  },
  RefreshDto: { refreshToken: '{{refreshToken}}' },
  VerifyPinDto: { pin: '{{pin}}', action: '{{action}}' },
  PinDto: {
    pin: '{{pin}}',
    confirmPin: '{{pin}}',
    stepUpToken: '{{stepUpToken}}',
  },
  ChangePasswordDto: {
    current: '{{password}}',
    next: 'replace-with-new-password',
    stepUpToken: '{{stepUpToken}}',
  },
  ResetRequestDto: { email: '{{email}}' },
  ResetConfirmDto: {
    token: '{{resetToken}}',
    newPassword: 'replace-with-new-password',
  },
  UpdateProfileDto: { fullName: 'Demo Customer' },
  QuoteDto: { fromAccountId: '{{accountId}}', amount: 100, currency: 'USD' },
  TransferDto: {
    fromAccountId: '{{accountId}}',
    beneficiaryId: '{{beneficiaryId}}',
    amount: 100,
    fee: 0,
    note: 'Simulated transfer',
    stepUpToken: '{{stepUpToken}}',
  },
  BeneficiaryDto: {
    name: 'Ama Mensah',
    bank: 'Demo Bank',
    accountNumber: '001234567890',
    stepUpToken: '{{stepUpToken}}',
  },
  CardDto: {
    brand: 'visa',
    label: 'Simulated card',
    last4: '4242',
    expiry: '12/29',
  },
  FrozenDto: { frozen: true },
  OrderDto: {
    productId: '{{productId}}',
    side: 'buy',
    units: 1,
    price: 0,
    fee: 0,
    stepUpToken: '{{stepUpToken}}',
  },
  SecurityDto: { transactionAlerts: true },
  PreferencesDto: { currency: 'USD' },
  DisputeDto: { reason: 'not_recognised' },
  AccountPatchDto: {frozen:true},
  CardPatchDto: {label:'Updated nickname',frozen:false},
  PasswordProofDto: {password:'{{password}}',stepUpToken:'{{stepUpToken}}'},
  TokenDto:{token:'{{verificationToken}}'},
  OtpDto:{code:'{{otpCode}}'},
  DisableMfaDto:{password:'{{password}}',code:'{{otpCode}}',stepUpToken:'{{stepUpToken}}'},
  MfaLoginDto:{challengeToken:'{{challengeToken}}',code:'{{otpCode}}'},
  StepDto:{stepUpToken:'{{stepUpToken}}'},
  BiometricChallengeDto:{action:'{{action}}'},
  RegistrationProofDto:{challengeToken:'{{challengeToken}}',response:{}},
  AuthenticationProofDto:{challengeToken:'{{challengeToken}}',response:{}},
  PushTokenDto:{provider:'expo',token:'replace-with-device-push-token'},
};
let sequence = 0;
for (const [documentPath, methods] of Object.entries(doc.paths)) {
  const path=documentPath.replace(/^\/api\/v1/,'');
  for (const [method, operation] of Object.entries(methods)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    sequence++;
    const type = path.includes('biometric-credentials') ? 'credential' : path.includes('push-tokens') ? 'pushToken' : path.startsWith('/investments/orders') ? 'order' : path.startsWith('/accounts')
      ? 'account'
      : path.startsWith('/transactions')
        ? 'transaction'
        : path.startsWith('/transfers')
          ? 'transfer'
          : path.startsWith('/beneficiaries')
            ? 'beneficiary'
            : path.startsWith('/cards')
              ? 'card'
              : path.includes('watchlist') || path.includes('products')
                ? 'product'
                : path.startsWith('/notifications')
                  ? 'notification'
                  : 'device';
    const route = documentPath.replace('{id}', '{{' + type + 'Id}}');
    const dto = operation.requestBody?.content?.[
      'application/json'
    ]?.schema?.$ref
      ?.split('/')
      .at(-1);
    let body = dto ? bodies[dto] : undefined;
    if (path === '/auth/pin/set')
      body = { pin: '{{pin}}', confirmPin: '{{pin}}',setupToken:'{{setupToken}}' };
    const isPublic =
      path === '/health' ||
      ['/auth/register', '/auth/login', '/auth/refresh','/auth/2fa/login/verify','/auth/email-verification/request','/auth/email-verification/confirm'].includes(path) ||
      path.includes('password-reset') ||
      path.includes('password/reset');
    let text = `meta {
  name: ${method.toUpperCase()} ${documentPath}
  type: http
  seq: ${sequence}
}

${method} {
  url: {{baseUrl}}${route}
  body: ${body ? 'json' : 'none'}
  auth: ${isPublic ? 'none' : 'bearer'}
}
`;
    if (!isPublic) text += '\nauth:bearer {\n  token: {{accessToken}}\n}\n';
    if (
      method === 'post' &&
      ['/transfers', '/investments/orders'].includes(path)
    )
      text += '\nheaders {\n  Idempotency-Key: {{idempotencyKey}}\n}\n';
    if (body)
      text +=
        '\nbody:json {\n' +
        JSON.stringify(body, null, 2)
          .split('\n')
          .map((l) => '  ' + l)
          .join('\n') +
        '\n}\n';
    let script = '';
    if (['/auth/login', '/auth/register', '/auth/refresh','/auth/2fa/login/verify'].includes(path))
      script +=
        'if (res.body.accessToken) { bru.setVar("accessToken", res.body.accessToken); bru.setVar("refreshToken", res.body.refreshToken); }\n';
    script+='if (res.body.challengeToken) bru.setVar("challengeToken",res.body.challengeToken);\nif (res.body.setupToken) bru.setVar("setupToken",res.body.setupToken);\n';
    if (['/auth/pin/verify', '/auth/step-up/verify'].includes(path))
      script +=
        'if (res.body.stepUpToken) bru.setVar("stepUpToken", res.body.stepUpToken);\n';
    if (
      method === 'get' &&
      [
        '/accounts',
        '/beneficiaries',
        '/cards',
        '/investments/products',
        '/notifications',
      ].includes(path)
    )
      script += `if (res.body.length) bru.setVar("${type}Id", res.body[0].id);\n`;
    if (method === 'post' && path === '/transfers')
      script +=
        'if (res.body.id) { bru.setVar("transferId", res.body.id); bru.setVar("transactionId", res.body.transactionId); }\n';
    if (method === 'post' && path === '/beneficiaries')
      script += 'if (res.body.id) bru.setVar("beneficiaryId", res.body.id);\n';
    if (script)
      text +=
        '\nscript:post-response {\n' +
        script
          .trim()
          .split('\n')
          .map((l) => '  ' + l)
          .join('\n') +
        '\n}\n';
    await writeFile(
      'bruno/' +
        method +
        '-' +
        documentPath.slice(1).replace(/\//g, '__').replace(/[{}]/g, '') +
        '.bru',
      text,
    );
  }
}
await writeFile(
  'bruno/README.md',
  `Open this folder as a Bruno collection and select Local. Configure email/password, then login, list accounts/beneficiaries/products, and verify the PIN before a sensitive action. Set action to transfer, investment_order, beneficiary_add, pin_change, password_change, or security_downgrade as appropriate. Every confirmation is single-use. Keep Idempotency-Key unchanged for retries; change it for each new transfer or order. Session tokens stay in your local Bruno environment. Do not commit populated tokens. Reset tokens are delivered to .tmp/mail in development. Requests are an endpoint catalogue, not an ordered collection runner. ${sequence} requests generated from OpenAPI.\n`,
);
console.log('Generated ' + sequence + ' Bruno requests');
