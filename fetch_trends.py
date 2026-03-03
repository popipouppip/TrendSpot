import json
import os
from datetime import date
from pytrends.request import TrendReq
import anthropic

# --- Настройки ---
CLAUDE_API_KEY = os.getenv("ANTHROPIC_API_KEY")
CARDS_PER_DAY = 12  # сколько карточек генерировать

# --- Шаг 1: Берём тренды из Google Trends ---
def get_trends():
    print("Получаю тренды из Google Trends...")
    pytrends = TrendReq(hl='en-US', tz=360)
    trending = pytrends.trending_searches(pn='united_states')
    topics = trending[0].tolist()[:CARDS_PER_DAY]
    print(f"Найдено трендов: {len(topics)}")
    return topics

# --- Шаг 2: Генерируем карточку через Claude AI ---
def generate_card(topic, client):
    print(f"  Генерирую карточку: {topic}...")

    prompt = f"""Тема: "{topic}"

Напиши карточку тренда для предпринимателей на английском языке. Отвечай ТОЛЬКО валидным JSON без пояснений.

Формат:
{{
  "title": "Короткое название (до 5 слов)",
  "why_trending": "Почему это сейчас актуально (2-3 предложения с цифрами)",
  "ways_to_earn": [
    "Первый конкретный способ заработать",
    "Второй конкретный способ заработать",
    "Третий конкретный способ заработать"
  ],
  "difficulty": "Easy",
  "income_estimate": "$X–Y per month",
  "what_you_need": "Что нужно чтобы начать (одна строка)"
}}

difficulty должно быть одно из: Easy / Medium / Hard"""

    message = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=500,
        messages=[{"role": "user", "content": prompt}]
    )

    raw = message.content[0].text.strip()
    try:
        card = json.loads(raw)
        card["topic"] = topic
        return card
    except json.JSONDecodeError:
        print(f"    Не удалось распарсить JSON, пропускаю")
        return None

# --- Шаг 3: Сохраняем карточки в JSON файл ---
def save_cards(cards):
    today = date.today().isoformat()
    os.makedirs("data", exist_ok=True)
    filepath = f"data/{today}.json"
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump({"date": today, "cards": cards}, f, ensure_ascii=False, indent=2)
    print(f"\nСохранено: {filepath} ({len(cards)} карточек)")
    return filepath

# --- Главная функция ---
def main():
    if not CLAUDE_API_KEY:
        print("Ошибка: не найден ANTHROPIC_API_KEY")
        print("Создай файл .env и добавь туда: ANTHROPIC_API_KEY=твой_ключ")
        return

    client = anthropic.Anthropic(api_key=CLAUDE_API_KEY)

    try:
        topics = get_trends()
    except Exception as e:
        print(f"Ошибка при получении трендов: {e}")
        print("Проверь интернет-соединение или VPN.")
        return

    cards = []
    for topic in topics:
        try:
            card = generate_card(topic, client)
            if card:
                cards.append(card)
        except Exception as e:
            print(f"  Ошибка для '{topic}': {e}")

    if cards:
        save_cards(cards)
        print("Готово! Теперь открой index.html в браузере.")
    else:
        print("Не удалось сгенерировать ни одной карточки.")

if __name__ == "__main__":
    main()
