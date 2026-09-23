from app.pii import mask_pii


def test_masks_kz_iban():
    text, found = mask_pii("Реквизиты: IBAN KZ86125KZT5004100100 для перевода.")
    assert text == "Реквизиты: IBAN [IBAN] для перевода."
    assert found["iban"] == 1


def test_masks_kz_iban_with_spaces_case_insensitively():
    text, found = mask_pii("Счёт: kz86 125k zt50 0410 0100.")
    assert text == "Счёт: [IBAN]."
    assert found["iban"] == 1


def test_masks_luhn_valid_card():
    text, found = mask_pii("Оплата картой 4111 1111 1111 1111 прошла успешно.")
    assert text == "Оплата картой [КАРТА] прошла успешно."
    assert found["card"] == 1


def test_leaves_luhn_invalid_card_untouched():
    original = "Номер карты 4111 1111 1111 1112 указан неверно."
    text, found = mask_pii(original)
    assert text == original
    assert found["card"] == 0


def test_masks_standalone_iin():
    text, found = mask_pii("Мой ИИН: 900101300123, проверьте данные.")
    assert text == "Мой ИИН: [ИИН], проверьте данные."
    assert found["iin"] == 1


def test_11_digit_number_is_not_iin():
    original = "Код заказа: 12345678901, уточните статус."
    text, found = mask_pii(original)
    assert text == original
    assert found["iin"] == 0


def test_13_digit_number_is_not_iin():
    original = "Код заказа: 1234567890123, уточните статус."
    text, found = mask_pii(original)
    assert text == original
    assert found["iin"] == 0
    assert found["card"] == 0  # Luhn-invalid, so not masked as a card either


def test_masks_kz_phone_numbers_in_different_formats():
    text, found = mask_pii(
        "Звоните: +7 701 234 56 78, либо 87012345678, либо +7(701)234-56-78."
    )
    assert text == "Звоните: [ТЕЛЕФОН], либо [ТЕЛЕФОН], либо [ТЕЛЕФОН]."
    assert found["phone"] == 3


def test_masks_email():
    text, found = mask_pii("Пишите на adil.test@example.kz по любым вопросам.")
    assert text == "Пишите на [EMAIL] по любым вопросам."
    assert found["email"] == 1


def test_text_without_pii_is_unchanged():
    original = "Курс доллара сегодня вырос на два процента к тенге."
    text, found = mask_pii(original)
    assert text == original
    assert found == {"iban": 0, "card": 0, "iin": 0, "phone": 0, "email": 0}


def test_several_kinds_in_one_text_have_correct_counts():
    _, found = mask_pii(
        "ИИН 900101300123, карта 4111 1111 1111 1111, "
        "телефон +7 701 234 56 78, email test@example.com"
    )
    assert found == {"iban": 0, "card": 1, "iin": 1, "phone": 1, "email": 1}
