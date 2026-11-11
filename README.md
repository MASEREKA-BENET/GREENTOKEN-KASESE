# GreenToken Kasese

GreenToken Kasese is a responsive farmer and carbon-credit management web application. It includes separate administrator, finance, and farmer portals, a Node.js API, and a persistent SQLite database.

## Technology stack

- **Frontend:** HTML, CSS, browser JavaScript
- **Backend:** Node.js 22.13 or newer, using its built-in HTTP server
- **Database:** SQLite through Node's built-in `node:sqlite` module
- **Authentication:** Password hashing with Node.js `crypto`; HTTP-only session cookies
- **Dependencies:** No third-party npm packages are required

## Run locally

1. Install Node.js 22.13 or newer.
2. Open a terminal in this project folder.
3. Run:

   ```sh
   npm start
   ```

4. Visit <http://localhost:3000>.

If port 3000 is already occupied, set another port before starting. For example, in PowerShell:

```powershell
$env:PORT = "3101"
npm start
```

## First-run accounts

| Role | Username | Password | Notes |
| --- | --- | --- | --- |
| Administrator | `admin` | `admin123` | Change before production deployment |
| Finance | `finance` | `finance123` | Change before production deployment |
| Farmer | `farmer001` | `default123` | Prompts for a new password |

These are development credentials only. Farmer accounts registered through the public registration form need admin approval before they can log in. Farmer accounts created by an administrator must change their temporary password at first sign-in.

## User roles and features

### Administrator

- Review, approve, register, and manage farmer accounts
- View farmer profiles and farmer records
- Respond to farmer complaints
- Message the finance account
- Update the USD-to-UGX exchange rate; the updated rate is shared across the portals
- Download farmer details as CSV, print/save a farmer register as PDF, and export a JSON report

### Finance

- View approved farmers and payout records
- Record credit sales and payouts; the system calculates the 20% commission and 80% farmer share
- Download farmer details and payout ledgers as CSV
- Print/save the farmer register as PDF
- Message the administrator

### Farmer

- View personal profile, carbon-credit estimate, earnings, and payment ledger
- Submit complaints and view administrator responses
- Use the currency converter with the administrator's current exchange rate

The login and dashboards have a persistent light/dark theme toggle and responsive layouts for phones, tablets, and desktop screens.

## Data and configuration

The database is created automatically at `data/greentoken.sqlite`. It persists across local server restarts. Back up the database file regularly.

Configure the application using environment variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port; defaults to `3000` |
| `GREENTOKEN_DB_PATH` | SQLite database path; defaults to `data/greentoken.sqlite` |
| `ADMIN_USERNAME` | Initial administrator username |
| `ADMIN_PASSWORD` | Initial administrator password |
| `FINANCE_USERNAME` | Initial finance username |
| `FINANCE_PASSWORD` | Initial finance password |
| `NODE_ENV` | Set to `production` to enable the session cookie's `Secure` flag |

Set unique administrator and finance credentials **before the first start**, since the initial accounts are only seeded when first created. Deploy behind HTTPS and back up the persistent database storage.

## Deploying to Render

Deploy this as a Render **Web Service**, not a Static Site:

1. Push the project to a Git repository and connect it to Render.
2. Set the build command to `npm install` and the start command to `npm start`.
3. Use Node.js 22.13 or newer.
4. Attach a persistent disk mounted at `/var/data`.
5. Set `GREENTOKEN_DB_PATH=/var/data/greentoken.sqlite` and set `NODE_ENV=production` plus unique admin/finance usernames and passwords.

The persistent disk is required so the SQLite database survives service restarts. The current SQLite design is intended for a single app instance. For multiple instances or larger deployments, migrate the database to a managed database service.

## Tests

Run the integration checks with:

```sh
npm test
```

The checks cover page and script loading, authentication, farmer approval, access scoping, complaint storage and responses, payout calculations, exchange-rate permissions, and export controls.

## Notes

- Payout records are stored in the ledger; the app does not send bank or mobile-money transfers.
- The exchange rate is manually maintained by an administrator. It is not fetched live from a currency service.
- Farmer CSV exports include contact, location, account, tree, credit, and earnings information. Passwords are never included.
