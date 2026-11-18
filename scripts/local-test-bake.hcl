target "runtime" {
  dockerfile = "Dockerfile"
}

target "check" {
  dockerfile = "tests/portable-fixtures/Dockerfile"
  args = {
    HARBOR_RUNTIME_IMAGE = "harbor-test-runtime"
  }
  contexts = {
    harbor-test-runtime = "target:runtime"
  }
}
