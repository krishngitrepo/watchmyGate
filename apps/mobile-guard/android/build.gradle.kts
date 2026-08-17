allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
/**
 * Pin every Android module to an SDK that is actually installed.
 *
 * A plugin declares `compileSdk 37`. The SDK manager installs that as `android-37.0`
 * while Gradle resolves the target as `android-37`, so the build fails on a platform
 * that is present under a different name. Every subproject is pinned to 36 instead —
 * installed, and enough for every plugin here.
 *
 * This must run *before* the `evaluationDependsOn` below: that call forces evaluation,
 * and `afterEvaluate` cannot be registered on a project that is already evaluated.
 *
 * `minSdk` 21 is the constraint that matters and lives in app/build.gradle.kts. Guards
 * run old, cheap hardware; raising it would exclude the users this app exists for.
 */
subprojects {
    afterEvaluate {
        extensions.findByName("android")?.let { ext ->
            (ext as com.android.build.gradle.BaseExtension).compileSdkVersion(36)
        }
    }
}

subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
