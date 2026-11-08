
import { useCallback, useEffect, useState } from "react";
import "./App.css";
import { getTranslations, type Language } from "./locales";



type Screen =
  | "language"
  | "phone"
  | "login"
  | "otp"
  | "register"
  | "dashboard";
type TransactionType = "income" | "expense";
type BusinessType =
  | "sole_proprietor"
  | "private_limited_company"
  | "community_organization";

interface Transaction {
  id: number;
  transaction_type: TransactionType;
  amount: string | number;
  category: string;
  description: string | null;
  transaction_date: string;
}

interface Summary {
  income: number;
  expenses: number;
  balance: number;
}

const languages = [
  { id: "en" as const, name: "English", subtitle: "Continue in English" },
  { id: "ta" as const, name: "தமிழ்", subtitle: "தமிழில் தொடரவும்" },
  { id: "si" as const, name: "සිංහල", subtitle: "සිංහලෙන් ඉදිරියට යන්න" },
];


export default function App() {
  const [language, setLanguage] = useState<Language | null>(() => {
    const stored = localStorage.getItem("noteto-language");
    return stored === "en" || stored === "ta" || stored === "si"
      ? stored
      : null;
  });

  const [screen, setScreen] = useState<Screen>("language");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [fullName, setFullName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [businessType, setBusinessType] =
    useState<BusinessType>("sole_proprietor");

  const [currentUser, setCurrentUser] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const [formType, setFormType] = useState<TransactionType | null>(null);
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [transactionDate, setTransactionDate] = useState(
    getLocalDate()
  );

  const [summary, setSummary] = useState<Summary>({
    income: 0,
    expenses: 0,
    balance: 0,
  });
  const [transactions, setTransactions] = useState<Transaction[]>([]);


  const t = getTranslations(language ?? "en");


  function changeLanguage(next: Language) {
    setLanguage(next);
    localStorage.setItem("noteto-language", next);
    setMessage("");
  }


  async function apiPost(path: string, body: unknown) {
    const response = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const responseText = await response.text();

    let data: any = {};

    if (responseText.trim()) {
      try {
        data = JSON.parse(responseText);
      } catch {
        throw new Error(
          `Server returned an invalid response (HTTP ${response.status}).`
        );
      }
    }

    if (!response.ok) {
      throw new Error(
        data.message ||
        `Request failed with HTTP ${response.status}.`
      );
    }

    if (!responseText.trim()) {
      throw new Error(
        "The server returned an empty response. Check your backend route."
      );
    }

    return data;
  }


  async function apiGet(path: string) {
    const response = await fetch(path, {
      method: "GET",
      credentials: "include",
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || t.genericError);
    }

    return data;
  }

  async function continueToPhone() {
    if (!language) {
      setMessage(t.required);
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      // Development-only OTP bypass.
      /*  const data = await apiPost(
         "/api/auth/dev-continue-registration",
         { phone_number: phone.trim() }
       ); */
      ///replace with above code
      await apiPost("/api/auth/dev-continue-registration", {
        phone_number: phone.trim(),
      });
      /////////////////////////////////////////////////////////////////////

      setMessage("");
      setScreen("register");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t.genericError);
    } finally {
      setLoading(false);
    }
  }

  async function requestOtp() {
    if (!phone.trim()) {
      setMessage(t.required);
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      const data = await apiPost("/api/auth/request-otp", {
        phone_number: phone.trim(),
      });

      setMessage(data.message || "");
      setOtp("");
      setScreen("otp");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t.genericError);
    } finally {
      setLoading(false);
    }
  }

  async function verifyOtp() {
    if (!/^\d{6}$/.test(otp.trim())) {
      setMessage("Please enter the six-digit OTP.");
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      const data = await apiPost("/api/auth/verify-otp", {
        phone_number: phone.trim(),
        otp: otp.trim(),
      });

      if (data.registration_required) {
        setScreen("register");
        setMessage("");
      } else {
        setCurrentUser(data.user?.full_name || phone);
        setScreen("dashboard");
        await loadDashboard();
      }

    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : t.genericError;

      setMessage(errorMessage);

      if (
        /already registered|already exists|phone number.*registered|mobile number.*registered/i.test(
          errorMessage
        )
      ) {
        setScreen("login");
      }
    } finally {
      setLoading(false);
    }

  }

  async function register() {
    if (!fullName.trim() || !businessName.trim() || !language) {
      setMessage(t.required);
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      const data = await apiPost("/api/auth/register", {
        full_name: fullName.trim(),
        business_name: businessName.trim(),
        business_type: businessType,
        preferred_language: language,
      });

      setCurrentUser(data.user?.full_name || fullName.trim());
      setScreen("dashboard");
      setFormType(null);
      await loadDashboard();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t.genericError);
    } finally {
      setLoading(false);
    }
  }


  const loadDashboard = useCallback(async () => {
    try {
      const [summaryData, transactionData] = await Promise.all([
        apiGet("/api/transactions/summary"),
        apiGet("/api/transactions"),
      ]);

      // Support either naming convention returned by the backend.
      const result = summaryData.summary ?? summaryData;

      setSummary({
        income: Number(result.income ?? result.todayIncome ?? 0),
        expenses: Number(result.expenses ?? result.todayExpenses ?? 0),
        balance: Number(result.balance ?? result.netBalance ?? 0),
      });

      const items = Array.isArray(transactionData)
        ? transactionData
        : transactionData.transactions;

      setTransactions(Array.isArray(items) ? items : []);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : t.genericError
      );
    }
  }, [language]);




  useEffect(() => {
    if (screen === "dashboard") {
      void loadDashboard();
    }
  }, [screen, loadDashboard]);

  function openTransactionForm(type: TransactionType) {
    setFormType(type);
    setAmount("");
    setDescription("");
    setTransactionDate(getLocalDate());
    setCategory(type === "income" ? "Sales" : "Supplies");
    setMessage("");
  }

  async function saveTransaction(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!formType || !amount || !category || !transactionDate) {
      setMessage(t.required);
      return;
    }

    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setMessage("Enter an amount greater than zero.");
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      await apiPost("/api/transactions", {
        transaction_type: formType,
        amount: numericAmount,
        category,
        description: description.trim() || null,
        transaction_date: transactionDate,
      });

      setFormType(null);
      setMessage(t.saved);
      await loadDashboard();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t.genericError);
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    try {
      await apiPost("/api/auth/logout", {});
    } catch {
      // Clear the local screen even if the server is unavailable.
    }

    setPhone("");
    setOtp("");
    setFullName("");
    setBusinessName("");
    setCurrentUser("");
    setTransactions([]);
    setSummary({ income: 0, expenses: 0, balance: 0 });
    setFormType(null);
    setMessage("");
    setScreen("language");
  }

  const money = (value: number | string) =>
    new Intl.NumberFormat("en-LK", {
      style: "currency",
      currency: "LKR",
      maximumFractionDigits: 2,
    }).format(Number(value) || 0);






  const translateCategory = (value: string): string => {
    const tamil: Record<string, string> = {
      Sales: "விற்பனை",
      Services: "சேவைகள்",
      "Other income": "பிற வருமானம்",
      Rent: "வாடகை",
      Utilities: "மின்சாரம் மற்றும் தண்ணீர்",
      Supplies: "பொருட்கள்",
      Transport: "போக்குவரத்து",
      Salaries: "சம்பளம்",
      "Other expense": "பிற செலவு",
    };

    const sinhala: Record<string, string> = {
      Sales: "විකුණුම්",
      Services: "සේවා",
      "Other income": "වෙනත් ආදායම්",
      Rent: "කුලිය",
      Utilities: "විදුලිය සහ ජලය",
      Supplies: "සැපයුම්",
      Transport: "ප්‍රවාහනය",
      Salaries: "වැටුප්",
      "Other expense": "වෙනත් වියදම්",
    };

    if (language === "ta") {
      return tamil[value] ?? value;
    }

    if (language === "si") {
      return sinhala[value] ?? value;
    }

    return value;
  };

  const formatTransactionDate = (value: string): string => {
    if (!value) return "";

    // Use the calendar date returned by the API.
    const datePart = value.slice(0, 10);
    const parts = datePart.split("-").map(Number);

    if (
      parts.length !== 3 ||
      parts.some((part) => !Number.isFinite(part)) ||
      parts[0] < 1 ||
      parts[1] < 1 ||
      parts[1] > 12 ||
      parts[2] < 1 ||
      parts[2] > 31
    ) {
      return value;
    }

    const date = new Date(parts[0], parts[1] - 1, parts[2]);

    const locale =
      language === "ta"
        ? "ta-LK"
        : language === "si"
          ? "si-LK"
          : "en-LK";

    return new Intl.DateTimeFormat(locale, {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(date);
  };


  function getLocalDate(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
  }


  return (
    <main className="welcome-page">
      <section className="welcome-card">
        <div className="brand-mark">N</div>
        <h1 className="brand-name">noteto</h1>
        <p className="tagline">{t.tagline}</p>

        {screen === "language" && (
          <>
            <h2 className="screen-title">{t.choose}</h2>

            <div className="language-list">
              {languages.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`language-option ${language === item.id ? "selected" : ""
                    }`}
                  onClick={() => changeLanguage(item.id)}
                  aria-pressed={language === item.id}
                >
                  <span className="language-name">{item.name}</span>
                  <span className="language-subtitle">{item.subtitle}</span>
                  {language === item.id && (
                    <span className="selection-mark">✓</span>
                  )}
                </button>
              ))}
            </div>

            <button className="primary-button" disabled={!language || loading}
              onClick={() => {
                setMessage("");
                setScreen("phone");
              }}
            >
              {t.register}
            </button>



            <button
              type="button"
              className="secondary-button"
              disabled={loading}
              onClick={() => {
                setMessage("");
                setScreen("login");
              }}
            >
              {t.login}
            </button>


          </>
        )}

        {screen === "phone" && (
          <>
            <h2 className="screen-title">{t.phoneTitle}</h2>
            <p>{t.phoneHelp}</p>

            <label className="field-label" htmlFor="phone">
              {t.phoneLabel}
            </label>
            <input
              id="phone"
              type="tel"
              autoComplete="tel"
              placeholder="+94771234567"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />

            <button
              className="primary-button"
              disabled={loading}
              onClick={continueToPhone}
            >
              {loading ? t.loading : t.sendOtp}
            </button>

            <button
              className="text-button"
              onClick={() => setScreen("language")}
            >
              {t.back}
            </button>

            <button
              className="text-button"
              disabled={loading}
              onClick={requestOtp}
            >
              Use OTP verification instead
            </button>
          </>
        )}




        {screen === "login" && t && (
          <>
            <h2 className="screen-title">{t.loginTitle}</h2>
            <p>{t.registeredPhoneHelp}</p>

            <label className="field-label" htmlFor="loginPhone">
              {t.mobileNumber}
            </label>

            <input
              id="loginPhone"
              type="tel"
              autoComplete="tel"
              placeholder="+94771234567"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />

            <button
              type="button"
              className="primary-button"
              disabled={loading}
              onClick={async () => {
                if (!phone.trim()) {
                  setMessage("Enter your mobile number.");
                  return;
                }

                setLoading(true);
                setMessage("");

                try {
                  const data = await apiPost("/api/auth/dev-login", {
                    phone_number: phone.trim(),
                  });

                  setCurrentUser(data.user?.full_name || phone.trim());
                  setScreen("dashboard");
                } catch (error) {
                  setMessage(
                    error instanceof Error
                      ? error.message
                      : "Login failed. Please try again."
                  );
                } finally {
                  setLoading(false);
                }
              }}
            >
              {loading ? "Please wait..." : t.login}
            </button>

            <button
              type="button"
              className="text-button"
              onClick={() => {
                setMessage("");
                setScreen("phone");
              }}
            >
              {t.createAccount}
            </button>

            <button
              type="button"
              className="text-button"
              onClick={() => setScreen("language")}
            >
              {t.back}
            </button>
          </>
        )}












        {screen === "otp" && (
          <>
            <h2 className="screen-title">{t.otpTitle}</h2>
            <p>{t.otpHelp}</p>
            <p className="phone-display">{phone}</p>

            <label className="field-label" htmlFor="otp">
              OTP
            </label>
            <input
              id="otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              value={otp}
              onChange={(event) =>
                setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))
              }
            />

            <button
              className="primary-button"
              disabled={loading}
              onClick={verifyOtp}
            >
              {loading ? t.loading : t.verify}
            </button>

            <button
              className="text-button"
              disabled={loading}
              onClick={requestOtp}
            >
              Resend OTP
            </button>

            <button
              className="text-button"
              onClick={() => setScreen("phone")}
            >
              {t.changePhone}
            </button>
          </>
        )}

        {screen === "register" && (
          <>
            <h2 className="screen-title">{t.registerTitle}</h2>
            <p className="phone-display">{phone}</p>

            <label className="field-label" htmlFor="fullName">
              {t.fullName}
            </label>
            <input
              id="fullName"
              autoComplete="name"
              maxLength={150}
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
            />

            <label className="field-label" htmlFor="businessName">
              {t.businessName}
            </label>
            <input
              id="businessName"
              maxLength={150}
              value={businessName}
              onChange={(event) => setBusinessName(event.target.value)}
            />

            <label className="field-label" htmlFor="businessType">
              {t.businessType}
            </label>
            <select
              id="businessType"
              value={businessType}
              onChange={(event) =>
                setBusinessType(event.target.value as BusinessType)
              }
            >
              <option value="sole_proprietor">{t.sole}</option>
              <option value="private_limited_company">{t.company}</option>
              <option value="community_organization">{t.community}</option>
            </select>

            <button
              className="primary-button"
              disabled={loading}
              onClick={register}
            >
              {loading ? t.loading : t.create}
            </button>



            <button
              type="button"
              className="secondary-button"
              disabled={loading}
              onClick={() => {
                setMessage("");
                setScreen("login");
              }}
            >
              {t.loginRegister}
            </button>

            <button
              type="button"
              className="text-button"
              disabled={loading}
              onClick={() => {
                setMessage("");
                setScreen("phone");
              }}
            >
              {t.back}
            </button>




          </>
        )}

        {screen === "dashboard" && (
          <>
            <h2 className="screen-title">{t.dashboard}</h2>
            <p>{t.welcome}</p>
            <p className="phone-display">{currentUser}</p>

            {formType ? (
              <form className="transaction-form" onSubmit={saveTransaction}>
                <h3>
                  {formType === "income" ? t.income : t.expense}
                </h3>

                <label className="field-label" htmlFor="amount">
                  {t.amount}
                </label>
                <input
                  id="amount"
                  type="number"
                  min="0.01"
                  max="9999999999.99"
                  step="0.01"
                  required
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />

                <label className="field-label" htmlFor="category">
                  {t.category}
                </label>
                <select
                  id="category"
                  required
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                >
                  {formType === "income" ? (
                    <>
                      <option value="Sales">{t.sales}</option>
                      <option value="Services">{t.services}</option>
                      <option value="Other income">{t.otherIncome}</option>
                    </>
                  ) : (
                    <>
                      <option value="Rent">{t.rent}</option>
                      <option value="Utilities">{t.utilities}</option>
                      <option value="Supplies">{t.supplies}</option>
                      <option value="Transport">{t.transport}</option>
                      <option value="Salaries">{t.salaries}</option>
                      <option value="Other expense">{t.otherExpense}</option>
                    </>
                  )}
                </select>

                <label className="field-label" htmlFor="transactionDate">
                  {t.date}
                </label>
                <input
                  id="transactionDate"
                  type="date"
                  required
                  value={transactionDate}
                  onChange={(event) => setTransactionDate(event.target.value)}
                />

                <label className="field-label" htmlFor="description">
                  {t.description}
                </label>
                <input
                  id="description"
                  maxLength={255}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />

                <button
                  className="primary-button"
                  type="submit"
                  disabled={loading}
                >
                  {loading ? t.loading : t.save}
                </button>

                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setFormType(null);
                    setMessage("");
                  }}
                >
                  {t.cancel}
                </button>
              </form>
            ) : (
              <>
                <div className="summary-grid">
                  <article className="summary-card income-card">
                    <span>{t.todayIncome}</span>
                    <strong>{money(summary.income)}</strong>
                  </article>

                  <article className="summary-card expense-card">
                    <span>{t.todayExpense}</span>
                    <strong>{money(summary.expenses)}</strong>
                  </article>

                  <article className="summary-card balance-card">
                    <span>{t.balance}</span>
                    <strong>{money(summary.balance)}</strong>
                  </article>
                </div>

                <div className="first-actions">
                  <button
                    className="primary-button"
                    onClick={() => openTransactionForm("income")}
                  >
                    + {t.income}
                  </button>

                  <button
                    className="secondary-button"
                    onClick={() => openTransactionForm("expense")}
                  >
                    − {t.expense}
                  </button>
                </div>

                <section className="transaction-history">
                  <h3>{t.history}</h3>

                  {transactions.length === 0 ? (
                    <p>{t.noTransactions}</p>
                  ) : (
                    <div className="transaction-list">
                      {transactions.map((item) => (
                        <article className="transaction-item" key={item.id}>
                          <div>
                            <strong>{translateCategory(item.category)}</strong>

                            {item.description && <p>{item.description}</p>}

                            <small>
                              {formatTransactionDate(item.transaction_date)}
                            </small>
                          </div>

                          <strong
                            className={
                              item.transaction_type === "income"
                                ? "income-text"
                                : "expense-text"
                            }
                          >
                            {item.transaction_type === "income" ? "+" : "−"}
                            {money(item.amount)}
                          </strong>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}


            <div className="dashboard-footer-actions">
              <button
                className="text-button"
                onClick={loadDashboard}
                disabled={loading}
              >
                {t.refresh}
              </button>

              <button
                className="text-button"
                onClick={logout}
                disabled={loading}
              >
                {t.logout}
              </button>
            </div>

          </>
        )}

        {message && (
          <p className="status-message" role="status">
            {message}
          </p>
        )}

        {screen !== "language" && (
          <div className="language-switcher">
            {languages.map((item) => (
              <button
                key={item.id}
                type="button"
                className={language === item.id ? "active-language" : ""}
                onClick={() => changeLanguage(item.id)}
              >
                {item.name}
              </button>
            ))}
          </div>
        )}
      </section>
    </main>
  );






}


