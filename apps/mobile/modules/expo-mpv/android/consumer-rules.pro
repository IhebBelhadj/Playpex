# Playpex: the JNI side (src/main/jni/mpv_jni.cpp) finds classes and methods of this package by name
# (FindClass("expo/modules/mpv/MPVLib"), the player's onEvent / onPropertyChange / onEndFile /
# onLogMessage callbacks): R8 must neither rename nor remove them, or a release build aborts with
# NoSuchMethodError as soon as mpv starts.
-keep class expo.modules.mpv.** { *; }
-keepclassmembers class * {
    void onEvent(int);
    void onPropertyChange(java.lang.String, java.lang.Object);
    void onEndFile(java.lang.String, java.lang.String);
    void onLogMessage(java.lang.String, java.lang.String, java.lang.String);
}
