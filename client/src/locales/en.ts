
const en = {
    choose: "Choose your language",
    tagline: "Simple bookkeeping for your business",
    continue: "Continue",
    login: "Login",
    register: "Register",
    dashboard: "Dashboard",
    welcome: "Welcome",

    // Phone registration
    phoneTitle: "Enter your mobile number",
    phoneHelp: "Enter your mobile number to continue.",
    phoneLabel: "Mobile number",
    sendOtp: "Send OTP",

    // OTP verification
    otpTitle: "OTP Verification",
    otpHelp: "Enter the six-digit OTP sent to your mobile number.",
    verify: "Verify",
    changePhone: "Change mobile number",

    // User registration
    registerTitle: "Create your account",
    fullName: "Full name",
    emailLabel: "Email address",
    invalidEmail: "Enter a valid email address.",
    businessName: "Business name",
    businessType: "Business type",
    sole: "Sole proprietor",
    company: "Private limited company",
    community: "Community organization",
    create: "Create account",
    loginRegister: "Go to Login",

    // Login
    loginTitle: "Login to Noteto",
    registeredPhoneHelp: "Enter your registered mobile number.",
    mobileNumber: "Mobile number",
    enterMobileNumber: "Enter your mobile number.",
    loginFailed: "Login failed. Please try again.",
    createAccount: "Create a new account",
    useOtpInstead: "Use OTP verification instead",
    resendOtp: "Resend OTP",
    invalidOtp: "Please enter the six-digit OTP.",
    invalidAmount: "Enter an amount greater than zero.",

    // Dashboard
    todayIncome: "Today's Income",
    todayExpense: "Today's Expenses",
    balance: "Today's Balance",
    income: "Income",
    expense: "Expense",
    history: "Recent Transactions",
    noTransactions: "No transactions yet",
    amount: "Amount",
    category: "Category",
    description: "Description",
    date: "Date",
    save: "Save Transaction",
    cancel: "Cancel",
    logout: "Logout",
    back: "Back",
    required: "This field is required",
    genericError: "Something went wrong. Please try again.",
    saved: "Transaction saved successfully",
    loading: "Loading...",
    noBusiness: "No business linked to this account",
    language: "Language",
    refresh: "Refresh dashboard",

    // Transaction categories used directly by App.tsx
    sales: "Sales",
    services: "Services",
    otherIncome: "Other income",
    rent: "Rent",
    utilities: "Utilities",
    supplies: "Supplies",
    transport: "Transport",
    salaries: "Salaries",
    otherExpense: "Other expense",
} as const;

export default en;
