#pragma once

typedef struct NotificationApp NotificationApp;
typedef int NotificationSequence;

void notification_message(
    NotificationApp* app,
    const NotificationSequence* sequence);
