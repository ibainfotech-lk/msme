
export type Language = "en" | "ta" | "si";

const translations = {
    en: {
        // General
        genericError: "Something went wrong. Please try again.",
        serverError: "An unexpected server error occurred.",
        notFound: "The requested resource was not found.",
        unauthorized: "Please log in to continue.",
        forbidden: "You do not have permission to perform this action.",
        invalidRequest: "Invalid request. Please check your information.",
        required: "Please fill in all required fields.",
        loading: "Please wait...",
        saved: "Your changes have been saved successfully.",

        // Authentication
        mobileNumber: "Mobile number",
        enterMobileNumber: "Please enter your mobile number.",
        invalidMobileNumber: "Please enter a valid mobile number.",
        mobileAlreadyRegistered: "This mobile number already has an account.",
        mobileNotRegistered: "No account was found for this mobile number.",
        loginSuccess: "You have logged in successfully.",
        loginFailed: "Login failed. Please try again.",
        registrationSuccess: "Your account has been created successfully.",
        registrationFailed: "Registration failed. Please try again.",
        logoutSuccess: "You have logged out successfully.",

        // OTP
        otpRequired: "Please enter the OTP.",
        invalidOtp: "Please enter a valid six-digit OTP.",
        otpExpired: "Your OTP has expired. Please request a new one.",
        otpSent: "A verification code has been sent.",
        otpVerified: "Your mobile number has been verified.",
        otpVerificationFailed: "OTP verification failed. Please try again.",
        otpResent: "A new verification code has been sent.",

        // Business
        businessNameRequired: "Please enter your business name.",
        businessNotFound: "Business not found.",
        businessCreated: "Your business has been created successfully.",
        invalidBusinessType: "Please select a valid business type.",

        // Transactions
        transactionNotFound: "Transaction not found.",
        transactionCreated: "Transaction recorded successfully.",
        transactionUpdated: "Transaction updated successfully.",
        transactionDeleted: "Transaction deleted successfully.",
        invalidAmount: "Please enter an amount greater than zero.",
        invalidTransactionType: "Please select a valid transaction type.",
        invalidCategory: "Please select a valid category.",
        invalidTransactionDate: "Please enter a valid transaction date.",
        descriptionTooLong: "The description is too long.",

        // Reports
        reportFailed: "Unable to generate the report. Please try again.",

        // Validation and limits
        validationFailed: "Please check the information you entered.",
        tooManyRequests: "Too many requests. Please try again later.",
        resourceLimitReached: "You have reached your current usage limit.",
    },

    ta: {
        // General
        genericError: "ஏதோ தவறு ஏற்பட்டுள்ளது. மீண்டும் முயற்சிக்கவும்.",
        serverError: "சேவையகத்தில் எதிர்பாராத பிழை ஏற்பட்டுள்ளது.",
        notFound: "கோரப்பட்ட தகவலைக் கண்டறிய முடியவில்லை.",
        unauthorized: "தொடர்வதற்கு உள்நுழையவும்.",
        forbidden: "இந்தச் செயலைச் செய்ய உங்களுக்கு அனுமதி இல்லை.",
        invalidRequest: "கோரிக்கை தவறானது. உங்கள் தகவல்களைச் சரிபார்க்கவும்.",
        required: "தேவையான அனைத்து புலங்களையும் நிரப்பவும்.",
        loading: "தயவுசெய்து காத்திருக்கவும்...",
        saved: "உங்கள் மாற்றங்கள் வெற்றிகரமாகச் சேமிக்கப்பட்டன.",

        // Authentication
        mobileNumber: "கைப்பேசி எண்",
        enterMobileNumber: "உங்கள் கைப்பேசி எண்ணை உள்ளிடவும்.",
        invalidMobileNumber: "சரியான கைப்பேசி எண்ணை உள்ளிடவும்.",
        mobileAlreadyRegistered:
            "இந்த கைப்பேசி எண்ணில் ஏற்கனவே ஒரு கணக்கு உள்ளது.",
        mobileNotRegistered:
            "இந்த கைப்பேசி எண்ணுக்கான கணக்கு எதுவும் இல்லை.",
        loginSuccess: "நீங்கள் வெற்றிகரமாக உள்நுழைந்துள்ளீர்கள்.",
        loginFailed: "உள்நுழைய முடியவில்லை. மீண்டும் முயற்சிக்கவும்.",
        registrationSuccess: "உங்கள் கணக்கு வெற்றிகரமாக உருவாக்கப்பட்டது.",
        registrationFailed: "கணக்கைப் பதிவு செய்ய முடியவில்லை. மீண்டும் முயற்சிக்கவும்.",
        logoutSuccess: "நீங்கள் வெற்றிகரமாக வெளியேறியுள்ளீர்கள்.",

        // OTP
        otpRequired: "OTP குறியீட்டை உள்ளிடவும்.",
        invalidOtp: "சரியான ஆறு இலக்க OTP குறியீட்டை உள்ளிடவும்.",
        otpExpired: "OTP காலாவதியாகிவிட்டது. புதிய OTP கோரவும்.",
        otpSent: "சரிபார்ப்புக் குறியீடு அனுப்பப்பட்டுள்ளது.",
        otpVerified: "உங்கள் கைப்பேசி எண் சரிபார்க்கப்பட்டது.",
        otpVerificationFailed:
            "OTP சரிபார்க்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.",
        otpResent: "புதிய சரிபார்ப்புக் குறியீடு அனுப்பப்பட்டுள்ளது.",

        // Business
        businessNameRequired: "உங்கள் வணிகத்தின் பெயரை உள்ளிடவும்.",
        businessNotFound: "வணிகத்தைக் கண்டறிய முடியவில்லை.",
        businessCreated: "உங்கள் வணிகம் வெற்றிகரமாக உருவாக்கப்பட்டது.",
        invalidBusinessType: "சரியான வணிக வகையைத் தேர்ந்தெடுக்கவும்.",

        // Transactions
        transactionNotFound: "பரிவர்த்தனையைக் கண்டறிய முடியவில்லை.",
        transactionCreated: "பரிவர்த்தனை வெற்றிகரமாகப் பதிவு செய்யப்பட்டது.",
        transactionUpdated: "பரிவர்த்தனை வெற்றிகரமாகப் புதுப்பிக்கப்பட்டது.",
        transactionDeleted: "பரிவர்த்தனை வெற்றிகரமாக நீக்கப்பட்டது.",
        invalidAmount: "பூஜ்ஜியத்தை விட அதிகமான தொகையை உள்ளிடவும்.",
        invalidTransactionType: "சரியான பரிவர்த்தனை வகையைத் தேர்ந்தெடுக்கவும்.",
        invalidCategory: "சரியான வகையைத் தேர்ந்தெடுக்கவும்.",
        invalidTransactionDate: "சரியான பரிவர்த்தனைத் தேதியை உள்ளிடவும்.",
        descriptionTooLong: "விளக்கம் மிக நீளமாக உள்ளது.",

        // Reports
        reportFailed: "அறிக்கையை உருவாக்க முடியவில்லை. மீண்டும் முயற்சிக்கவும்.",

        // Validation and limits
        validationFailed: "நீங்கள் உள்ளிட்ட தகவல்களைச் சரிபார்க்கவும்.",
        tooManyRequests: "பல கோரிக்கைகள் அனுப்பப்பட்டுள்ளன. சிறிது நேரம் கழித்து முயற்சிக்கவும்.",
        resourceLimitReached: "தற்போதைய பயன்பாட்டு வரம்பை அடைந்துவிட்டீர்கள்.",
    },

    si: {
        // General
        genericError: "දෝෂයක් ඇති විය. කරුණාකර නැවත උත්සාහ කරන්න.",
        serverError: "සේවාදායකයේ අනපේක්ෂිත දෝෂයක් ඇති විය.",
        notFound: "ඉල්ලා සිටි තොරතුරු සොයාගත නොහැක.",
        unauthorized: "ඉදිරියට යාමට කරුණාකර පිවිසෙන්න.",
        forbidden: "මෙම ක්‍රියාව සිදු කිරීමට ඔබට අවසර නැත.",
        invalidRequest: "ඉල්ලීම වැරදියි. ඔබගේ තොරතුරු පරීක්ෂා කරන්න.",
        required: "අවශ්‍ය සියලුම ක්ෂේත්‍ර පුරවන්න.",
        loading: "කරුණාකර රැඳී සිටින්න...",
        saved: "ඔබගේ වෙනස්කම් සාර්ථකව සුරකින ලදී.",

        // Authentication
        mobileNumber: "ජංගම දුරකථන අංකය",
        enterMobileNumber: "කරුණාකර ඔබගේ ජංගම දුරකථන අංකය ඇතුළත් කරන්න.",
        invalidMobileNumber: "වලංගු ජංගම දුරකථන අංකයක් ඇතුළත් කරන්න.",
        mobileAlreadyRegistered:
            "මෙම ජංගම දුරකථන අංකයට දැනටමත් ගිණුමක් ඇත.",
        mobileNotRegistered:
            "මෙම ජංගම දුරකථන අංකයට අදාළ ගිණුමක් හමු නොවීය.",
        loginSuccess: "ඔබ සාර්ථකව පිවිසී ඇත.",
        loginFailed: "පිවිසීමට නොහැකි විය. කරුණාකර නැවත උත්සාහ කරන්න.",
        registrationSuccess: "ඔබගේ ගිණුම සාර්ථකව සාදන ලදී.",
        registrationFailed: "ලියාපදිංචි වීමට නොහැකි විය. නැවත උත්සාහ කරන්න.",
        logoutSuccess: "ඔබ සාර්ථකව ඉවත් වී ඇත.",

        // OTP
        otpRequired: "කරුණාකර OTP කේතය ඇතුළත් කරන්න.",
        invalidOtp: "වලංගු ඉලක්කම් හයක OTP කේතයක් ඇතුළත් කරන්න.",
        otpExpired: "OTP කේතයේ වලංගු කාලය අවසන් වී ඇත. නව කේතයක් ඉල්ලන්න.",
        otpSent: "සත්‍යාපන කේතයක් යවා ඇත.",
        otpVerified: "ඔබගේ ජංගම දුරකථන අංකය සත්‍යාපනය කර ඇත.",
        otpVerificationFailed:
            "OTP සත්‍යාපනය අසාර්ථක විය. නැවත උත්සාහ කරන්න.",
        otpResent: "නව සත්‍යාපන කේතයක් යවා ඇත.",

        // Business
        businessNameRequired: "කරුණාකර ඔබගේ ව්‍යාපාරයේ නම ඇතුළත් කරන්න.",
        businessNotFound: "ව්‍යාපාරය සොයාගත නොහැක.",
        businessCreated: "ඔබගේ ව්‍යාපාරය සාර්ථකව සාදන ලදී.",
        invalidBusinessType: "කරුණාකර නිවැරදි ව්‍යාපාර වර්ගය තෝරන්න.",

        // Transactions
        transactionNotFound: "ගනුදෙනුව සොයාගත නොහැක.",
        transactionCreated: "ගනුදෙනුව සාර්ථකව සටහන් කරන ලදී.",
        transactionUpdated: "ගනුදෙනුව සාර්ථකව යාවත්කාලීන කරන ලදී.",
        transactionDeleted: "ගනුදෙනුව සාර්ථකව මකා දමන ලදී.",
        invalidAmount: "කරුණාකර ශුන්‍යයට වඩා වැඩි මුදලක් ඇතුළත් කරන්න.",
        invalidTransactionType: "කරුණාකර නිවැරදි ගනුදෙනු වර්ගය තෝරන්න.",
        invalidCategory: "කරුණාකර නිවැරදි වර්ගය තෝරන්න.",
        invalidTransactionDate: "කරුණාකර නිවැරදි ගනුදෙනු දිනය ඇතුළත් කරන්න.",
        descriptionTooLong: "විස්තරය දිග වැඩියි.",

        // Reports
        reportFailed: "වාර්තාව සෑදීමට නොහැකි විය. නැවත උත්සාහ කරන්න.",

        // Validation and limits
        validationFailed: "ඔබ ඇතුළත් කළ තොරතුරු පරීක්ෂා කරන්න.",
        tooManyRequests: "ඉල්ලීම් බොහෝමයක් යවා ඇත. පසුව නැවත උත්සාහ කරන්න.",
        resourceLimitReached: "ඔබගේ වත්මන් භාවිත සීමාවට පැමිණ ඇත.",
    },
} as const;

export type TranslationKey = keyof typeof translations.en;

export function getTranslations(language?: unknown) {
    const selectedLanguage: Language =
        language === "ta" || language === "si" ? language : "en";

    return translations[selectedLanguage];
}

export function translate(
    key: TranslationKey,
    language?: unknown
): string {
    return getTranslations(language)[key];
}
