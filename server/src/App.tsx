
import { useState } from "react";
import "./App.css";

const translations = {
    en: {
        title: "Welcome to noteto",
        subtitle: "Simple bookkeeping for your business.",
        income: "Add Income",
        expense: "Add Expense",
        reports: "View Reports",
        language: "Choose your language",
    },
    ta: {
        title: "noteto-விற்கு வரவேற்கிறோம்",
        subtitle: "உங்கள் வணிகத்திற்கான எளிய கணக்குப் பதிவு.",
        income: "வரவு சேர்",
        expense: "செலவு சேர்",
        reports: "அறிக்கைகளைப் பார்க்க",
        language: "மொழியைத் தேர்ந்தெடுக்கவும்",
    },
    si: {
        title: "noteto වෙත සාදරයෙන් පිළිගනිමු",
        subtitle: "ඔබේ ව්‍යාපාරය සඳහා සරල ගිණුම්කරණය.",
        income: "ආදායම එක් කරන්න",
        expense: "වියදම එක් කරන්න",
        reports: "වාර්තා බලන්න",
        language: "ඔබේ භාෂාව තෝරන්න",
    },
};

type Language = keyof typeof translations;

function App() {
    const [language, setLanguage] = useState<Language>("en");
    const t = translations[language];

    return (
        <main className="app">
            <header className="topbar">
                <span className="brand">noteto</span>
                <label>
                    {t.language}
                    <select
                        value={language}
                        onChange={(event) =>
                            setLanguage(event.target.value as Language)
                        }
                    >
                        <option value="en">English</option>
                        <option value="ta">தமிழ்</option>
                        <option value="si">සිංහල</option>
                    </select>
                </label>
            </header>

            <section className="welcome">
                <p className="eyebrow">YOUR BUSINESS, SIMPLIFIED</p>
                <h1>{t.title}</h1>
                <p>{t.subtitle}</p>

                <div className="actions">
                    <button onClick={() => alert("Income module coming next!")}>
                        + {t.income}
                    </button>
                    <button
                        className="secondary"
                        onClick={() => alert("Expense module coming next!")}
                    >
                        + {t.expense}
                    </button>
                    <button
                        className="secondary"
                        onClick={() => alert("Reports module coming next!")}
                    >
                        {t.reports}
                    </button>
                </div>
            </section>
        </main>
    );
}

export default App;
