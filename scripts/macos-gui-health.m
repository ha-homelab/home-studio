// Read-only Quartz/AppKit metadata. No screenshots, TCC requests, activation,
// display configuration, power assertions, private APIs, or user identity data.
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#include <math.h>
#include <stdio.h>
#include <unistd.h>

static id number(double value) {
    return isfinite(value) ? @(value) : NSNull.null;
}

static NSNumber *flag(BOOL value) {
    return value ? @YES : @NO;
}

static NSDictionary *bounds(CGRect rect) {
    return @{ @"x": number(rect.origin.x), @"y": number(rect.origin.y),
              @"width": number(rect.size.width), @"height": number(rect.size.height) };
}

static id boolean(NSDictionary *dictionary, CFStringRef key) {
    id value = dictionary[(__bridge NSString *)key];
    return value && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()
        ? @([value boolValue]) : NSNull.null;
}

int main(void) {
    alarm(5); // A stuck native metadata query must not outlive this probe.
    @autoreleasepool {
        const uint32_t displayLimit = 8;
        CGDirectDisplayID online[8] = {0}, active[8] = {0};
        uint32_t onlineCount = 0, activeCount = 0;
        CGError onlineError = CGGetOnlineDisplayList(displayLimit, online, &onlineCount);
        CGError activeError = CGGetActiveDisplayList(displayLimit, active, &activeCount);
        NSMutableArray *displays = NSMutableArray.array;
        if (onlineError == kCGErrorSuccess) {
            for (uint32_t i = 0; i < MIN(onlineCount, displayLimit); i++) {
                CGDirectDisplayID display = online[i];
                CGDisplayModeRef mode = CGDisplayCopyDisplayMode(display);
                NSMutableDictionary *entry = [@{
                    @"index": @(i), @"bounds": bounds(CGDisplayBounds(display)),
                    @"framebufferWidth": @(CGDisplayPixelsWide(display)),
                    @"framebufferHeight": @(CGDisplayPixelsHigh(display)),
                    @"online": flag(CGDisplayIsOnline(display) != 0),
                    @"active": flag(CGDisplayIsActive(display) != 0),
                    @"asleep": flag(CGDisplayIsAsleep(display) != 0)
                } mutableCopy];
                if (mode) {
                    entry[@"modePixelWidth"] = @(CGDisplayModeGetPixelWidth(mode));
                    entry[@"modePixelHeight"] = @(CGDisplayModeGetPixelHeight(mode));
                    CGDisplayModeRelease(mode);
                }
                [displays addObject:entry];
            }
        }
        NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
        NSMutableSet<NSNumber *> *safariPIDs = NSMutableSet.set;
        NSArray<NSRunningApplication *> *apps =
            [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.Safari"];
        for (NSRunningApplication *app in apps) {
            if (safariPIDs.count >= 8) break;
            [safariPIDs addObject:@(app.processIdentifier)];
        }
        NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
        NSMutableArray *safariWindows = NSMutableArray.array;
        NSUInteger inspected = 0;
        for (NSDictionary *window in windows) {
            if (inspected++ >= 4096 || safariWindows.count >= 16) break;
            if (![safariPIDs containsObject:window[(__bridge NSString *)kCGWindowOwnerPID]]) continue;
            CGRect rect = CGRectZero;
            id rawBounds = window[(__bridge NSString *)kCGWindowBounds];
            BOOL validBounds = [rawBounds isKindOfClass:NSDictionary.class] &&
                CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)rawBounds, &rect);
            id layer = window[(__bridge NSString *)kCGWindowLayer];
            id alpha = window[(__bridge NSString *)kCGWindowAlpha];
            [safariWindows addObject:@{
                @"index": @(safariWindows.count),
                @"bounds": validBounds ? bounds(rect) : NSNull.null,
                @"layer": [layer isKindOfClass:NSNumber.class] ? number([layer doubleValue]) : NSNull.null,
                @"alpha": [alpha isKindOfClass:NSNumber.class] ? number([alpha doubleValue]) : NSNull.null,
                @"onScreen": boolean(window, kCGWindowIsOnscreen)
            }];
        }
        NSString *frontmost = NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier;
        id frontmostValue = frontmost.length > 0 && frontmost.length <= 128 ? frontmost : NSNull.null;
        NSDictionary *report = @{
            @"schema": @1, @"purpose": @"read-only-gui-health", @"acceptanceEvidence": @NO,
            @"timestampUnix": number(NSDate.date.timeIntervalSince1970),
            @"onlineDisplayQueryResult": @(onlineError), @"activeDisplayQueryResult": @(activeError),
            @"onlineCountWithinLimit": @(MIN(onlineCount, displayLimit)),
            @"activeCountWithinLimit": @(MIN(activeCount, displayLimit)),
            @"displayLimitPossiblyReached": flag(onlineCount >= displayLimit || activeCount >= displayLimit),
            @"displays": displays,
            @"session": @{ @"guiSessionAvailable": flag(session != nil),
                @"onConsole": boolean(session, kCGSessionOnConsoleKey),
                @"loginDone": boolean(session, kCGSessionLoginDoneKey),
                @"screenLocked": NSNull.null,
                @"screenLockedReason": @"Not exposed by documented public CGSession keys; no inference made" },
            @"safariRunning": flag(safariPIDs.count > 0),
            @"windowQueryAvailable": flag(windows != nil),
            @"windowScanLimitPossiblyReached": flag(windows.count > 4096 || safariWindows.count >= 16),
            @"safariVisibleWindows": safariWindows,
            @"frontmostBundleIdentifier": frontmostValue
        };
        NSData *json = [NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingSortedKeys error:nil];
        if (!json || json.length > 16384) {
            fputs("{\"error\":\"metadata_serialization_or_output_bound\"}\n", stdout);
            return 2;
        }
        fwrite(json.bytes, 1, json.length, stdout);
        fputc('\n', stdout);
    }
    return 0;
}
