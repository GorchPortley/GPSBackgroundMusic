plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "dev.gpsmusic"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.gpsmusic"
        // API 30 keeps foreground-service types and scoped storage simple, and
        // covers essentially every phone still receiving updates.
        minSdk = 30
        targetSdk = 37
        versionCode = 1
        versionName = "0.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // The web app ships verbatim in src/main/assets/www — no build step and no
    // bundler, so the APK contains exactly the files the server would serve.

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}
